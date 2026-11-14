// Starts a copy of the shop and sends it a day's traffic, the same every time for the same seed, and
// prints the events that the shop wrote. It is run by plain Node, in a process of its own, and
// imports nothing from this repository.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const seed = Number(process.argv[3] ?? 1);
if (root === undefined || !isAbsolute(root) || !Number.isInteger(seed)) {
  throw new Error("usage: run-traffic.ts <absolute path of the directory of the shop> [seed]");
}

interface Shop {
  server: Server;
}
const shopModule = (await import(pathToFileURL(join(root, "src/shop.ts")).href)) as {
  createShop(options: {
    telemetry: unknown;
    clock: unknown;
    stock: Record<string, number>;
    store: unknown;
  }): Shop;
};
const telemetryModule = (await import(pathToFileURL(join(root, "src/telemetry.ts")).href)) as {
  MemoryTelemetry: new (clock: unknown) => { events: unknown[] };
};
const inventoryModule = (await import(pathToFileURL(join(root, "src/inventory.ts")).href)) as {
  MemoryStockStore: new (initial: Record<string, number>, latencyMs: number) => unknown;
};

/** Small, quick and the same every time: the same seed gives the same list of numbers. */
function random(from: number): () => number {
  let state = from >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const next = random(seed);
const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;

let reads = 0;
const clock = { now: () => new Date(Date.UTC(2026, 0, 15, 9, 0, 0) + 5 * reads++) };
const telemetry = new telemetryModule.MemoryTelemetry(clock);
// One teapot, so that customers who want it together cannot all have it.
const stock = { "MUG-01": 80, "TEA-05": 200, "POT-02": 1, "SPN-09": 400, "BOK-03": 80 };
// Stock lives in a database, and a call to it takes a few milliseconds to come back. That is the
// time in which two requests that arrive together can both see the same level.
const store = new inventoryModule.MemoryStockStore(stock, 5);
const { server } = shopModule.createShop({ telemetry, clock, stock, store });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const statuses: Record<string, number> = {};
async function send(method: string, path: string, body?: unknown, key?: string): Promise<void> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(key === undefined ? {} : { "idempotency-key": key }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await response.arrayBuffer();
  statuses[String(response.status)] = (statuses[String(response.status)] ?? 0) + 1;
}

interface OrderBody {
  customerId: string;
  lines: { sku: string; quantity: number }[];
  address?: { country: string };
  discountCode?: string;
}
const order = (body: OrderBody, key?: string): Promise<void> => send("POST", "/orders", body, key);

// Browsing.
await send("GET", "/health");
await send("GET", "/products");

// A morning of ordinary orders from ten customers. Some are collected in the shop, some use a code,
// and the carts are anything from one spoon up.
const products = ["MUG-01", "TEA-05", "SPN-09", "BOK-03"];
const countries = ["GB", "DE", "FR", "US"];
const codes = [undefined, undefined, "SPRING10", "WELCOME5"];
for (let index = 0; index < 60; index++) {
  const lines = Array.from({ length: 1 + Math.floor(next() * 3) }, () => ({
    sku: pick(products),
    quantity: 1 + Math.floor(next() * 2),
  }));
  const code = pick(codes);
  const body: OrderBody = {
    customerId: `cust-${String(1 + Math.floor(next() * 10)).padStart(2, "0")}`,
    lines,
  };
  if (next() > 0.15) body.address = { country: pick(countries) };
  if (code !== undefined) body.discountCode = code;
  await order(body, `ordinary-${index}`);
}

// Customers whose connection dropped, and who sent the same order again with the same key.
for (let index = 0; index < 6; index++) {
  const body: OrderBody = {
    customerId: `retry-${index}`,
    lines: [{ sku: "MUG-01", quantity: 1 }],
    address: { country: "GB" },
  };
  await order(body, `retry-${index}`);
  await order(body, `retry-${index}`);
}
// And two who sent it twice at once.
for (let index = 0; index < 3; index++) {
  const body: OrderBody = {
    customerId: `double-${index}`,
    lines: [{ sku: "TEA-05", quantity: 2 }],
    address: { country: "DE" },
  };
  await Promise.all([order(body, `double-${index}`), order(body, `double-${index}`)]);
}

// The last teapot, wanted by six customers at the same moment. Each one asks while the others'
// questions are still on their way to the stock, which is when a shop that checks and then takes
// as two steps sells it more than once.
const teapot = (customerId: string): OrderBody => ({
  customerId,
  lines: [{ sku: "POT-02", quantity: 1 }],
  address: { country: "FR" },
});
await Promise.all(["a", "b", "c", "d", "e", "f"].map((name) => order(teapot(`teapot-${name}`))));

// One customer who comes to the shop in person for a spoon with a welcome code, and one who orders
// the spoon to be sent.
await order({
  customerId: "spoon-a",
  lines: [{ sku: "SPN-09", quantity: 1 }],
  discountCode: "WELCOME5",
});
await order({
  customerId: "spoon-b",
  lines: [{ sku: "SPN-09", quantity: 1 }],
  address: { country: "GB" },
  discountCode: "WELCOME5",
});

// A regular with twenty-five orders, who reads her history by pages of ten and then of five.
for (let index = 0; index < 25; index++) {
  await order({
    customerId: "regular",
    lines: [{ sku: "SPN-09", quantity: 1 }],
    address: { country: "GB" },
  });
}
for (const size of [10, 5]) {
  for (let page = 1; page <= Math.ceil(25 / size); page++) {
    await send("GET", `/customers/regular/orders?page=${page}&pageSize=${size}`);
  }
}

await new Promise<void>((resolve) => server.close(() => resolve()));
process.stdout.write(`${JSON.stringify({ events: telemetry.events, statuses })}\n`);
