import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { OrderService } from "./orders.ts";
import { createShopServer } from "./server.ts";
import { listening, steppingClock, testShop } from "./testing.ts";
import { MemoryTelemetry } from "./telemetry.ts";

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const order = {
  customerId: "cust_1",
  lines: [{ sku: "MUG-01", quantity: 2 }],
  address: { country: "DE" },
  discountCode: "SPRING10",
};

describe("the shop over HTTP", () => {
  const shop = testShop({ stock: { "MUG-01": 30, "POT-02": 1 } });
  let base = "";
  let stop: () => Promise<void>;

  before(async () => {
    const running = await listening(shop.server);
    base = running.url;
    stop = running.close;
  });
  after(async () => {
    await stop();
  });

  it("says it is well", async () => {
    assert.deepEqual(await call(base, "GET", "/health"), { status: 200, body: { ok: true } });
  });

  it("lists what it sells, with prices", async () => {
    const { status, body } = await call(base, "GET", "/products");
    assert.equal(status, 200);
    const products = body["products"] as { sku: string; priceCents: number; price: string }[];
    assert.equal(products.length, 5);
    assert.deepEqual(products[0], {
      sku: "MUG-01",
      name: "Enamel mug",
      priceCents: 1299,
      price: "12.99",
    });
  });

  it("makes an order, and answers a repeat of it with the same one", async () => {
    const headers = { "idempotency-key": "http-1" };
    const first = await call(base, "POST", "/orders", order, headers);
    assert.equal(first.status, 201);
    assert.equal(first.body["replayed"], false);
    const made = first.body["order"] as Record<string, unknown>;
    assert.equal(made["totalCents"], 2782);
    assert.equal(made["total"], "27.82");

    const again = await call(base, "POST", "/orders", order, headers);
    assert.equal(again.status, 200);
    assert.equal(again.body["replayed"], true);
    assert.equal((again.body["order"] as Record<string, unknown>)["id"], made["id"]);
  });

  it("makes an order for collection, which has no address, taxed as the shop's own country", async () => {
    const pickup = { customerId: order.customerId, lines: order.lines, discountCode: "SPRING10" };
    const { status, body } = await call(base, "POST", "/orders", pickup);
    assert.equal(status, 201);
    // 2598 less 260 is 2338, and 20% of that is 467.6.
    assert.equal((body["order"] as Record<string, unknown>)["taxCents"], 468);
  });

  it("refuses what is wrong with the request, and says which field", async () => {
    assert.deepEqual(await call(base, "POST", "/orders", { ...order, lines: [] }), {
      status: 400,
      body: { error: "invalid_request", field: "lines" },
    });
    assert.deepEqual(await call(base, "POST", "/orders", "{not json"), {
      status: 400,
      body: { error: "invalid_json" },
    });
    assert.deepEqual(
      await call(base, "POST", "/orders", order, { "idempotency-key": "k".repeat(200) }),
      { status: 400, body: { error: "invalid_request", field: "Idempotency-Key" } },
    );
  });

  it("refuses a body that is too large without reading all of it into an order", async () => {
    const huge = JSON.stringify({ ...order, pad: "x".repeat(70 * 1024) });
    assert.deepEqual(await call(base, "POST", "/orders", huge), {
      status: 413,
      body: { error: "body_too_large" },
    });
  });

  it("says why an order cannot be made", async () => {
    assert.deepEqual(
      await call(base, "POST", "/orders", { ...order, lines: [{ sku: "NOPE-1", quantity: 1 }] }),
      { status: 422, body: { error: "unknown_product", sku: "NOPE-1" } },
    );
    assert.deepEqual(await call(base, "POST", "/orders", { ...order, discountCode: "FREE" }), {
      status: 422,
      body: { error: "unknown_discount_code" },
    });
    const last = { ...order, lines: [{ sku: "POT-02", quantity: 1 }] };
    assert.equal((await call(base, "POST", "/orders", last)).status, 201);
    assert.deepEqual(await call(base, "POST", "/orders", last), {
      status: 409,
      body: { error: "out_of_stock", sku: "POT-02" },
    });
  });

  it("lists a customer's orders in pages", async () => {
    for (let index = 0; index < 12; index++) {
      await call(base, "POST", "/orders", {
        customerId: "pager",
        lines: [{ sku: "MUG-01", quantity: 1 }],
      });
    }
    const ids: string[] = [];
    for (const page of [1, 2]) {
      const { status, body } = await call(
        base,
        "GET",
        `/customers/pager/orders?page=${page}&pageSize=5`,
      );
      assert.equal(status, 200);
      assert.equal(body["total"], 12);
      for (const listed of body["orders"] as { id: string }[]) ids.push(listed.id);
    }
    assert.equal(ids.length, 10);
    assert.equal(new Set(ids).size, 10);
    const last = await call(base, "GET", "/customers/pager/orders?page=3&pageSize=5");
    assert.equal((last.body["orders"] as unknown[]).length, 2);
  });

  it("lists ten at a time when no page size is asked for", async () => {
    for (let index = 0; index < 12; index++) {
      await call(base, "POST", "/orders", {
        customerId: "defaults",
        lines: [{ sku: "MUG-01", quantity: 1 }],
      });
    }
    const { body } = await call(base, "GET", "/customers/defaults/orders");
    assert.equal(body["page"], 1);
    assert.equal(body["pageSize"], 10);
    assert.equal((body["orders"] as unknown[]).length, 10);
  });

  it("allows the last page number it supports, and refuses the next", async () => {
    const last = await call(base, "GET", "/customers/defaults/orders?page=1000000");
    assert.deepEqual(last.body["orders"], []);
    assert.deepEqual(await call(base, "GET", "/customers/defaults/orders?page=1000001"), {
      status: 400,
      body: { error: "invalid_request", field: "page" },
    });
  });

  it("refuses a page or page size that makes no sense", async () => {
    for (const [query, field] of [
      ["page=0", "page"],
      ["page=abc", "page"],
      ["page=-1", "page"],
      ["pageSize=0", "pageSize"],
      ["pageSize=51", "pageSize"],
    ] as const) {
      assert.deepEqual(await call(base, "GET", `/customers/pager/orders?${query}`), {
        status: 400,
        body: { error: "invalid_request", field },
      });
    }
  });

  it("does not have what is not there", async () => {
    assert.equal((await call(base, "GET", "/nothing")).status, 404);
    assert.equal((await call(base, "DELETE", "/orders")).status, 404);
    assert.equal((await call(base, "GET", "/customers/a b/orders")).status, 404);
  });

  it("writes one event for each request it served, with the route and how it went", () => {
    const requests = shop.telemetry.events.filter((event) => event.type === "http.request");
    const routes = new Set(requests.map((event) => event.attributes["route"]));
    assert.deepEqual([...routes].sort(), [
      "GET /customers/:id/orders",
      "GET /health",
      "GET /products",
      "POST /orders",
      "unmatched",
    ]);
    for (const event of requests) {
      assert.equal(typeof event.attributes["status"], "number");
      // The clock moves 5 ms with every reading, so a request takes a few steps of it, never more.
      const duration = Number(event.attributes["durationMs"]);
      assert.ok(duration >= 0 && duration < 500 && duration % 5 === 0, `took ${duration} ms`);
    }
    assert.ok(requests.some((event) => event.attributes["status"] === 413));
  });
});

describe("the shop when something goes wrong inside it", () => {
  it("tells the caller nothing of it, and tells its own telemetry everything", async () => {
    const clock = steppingClock();
    const telemetry = new MemoryTelemetry(clock);
    const failing = {
      createOrder: () => Promise.reject(new TypeError("password=hunter2 in the connection string")),
      listOrders: () => [],
      countOrders: () => 0,
    } as unknown as OrderService;
    const running = await listening(createShopServer({ orders: failing, telemetry, clock }));
    try {
      const reply = await call(running.url, "POST", "/orders", order);
      assert.deepEqual(reply, { status: 500, body: { error: "internal_error" } });
    } finally {
      await running.close();
    }

    const [captured, served] = telemetry.events;
    assert.equal(captured?.type, "error.captured");
    assert.equal(captured?.attributes["name"], "TypeError");
    assert.equal(captured?.attributes["message"], "password=hunter2 in the connection string");
    assert.equal(captured?.attributes["path"], "/orders");
    assert.equal(served?.type, "http.request");
    assert.equal(served?.attributes["status"], 500);
  });
});
