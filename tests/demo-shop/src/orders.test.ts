import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CreateOrderResult, OrderRequest } from "./orders.ts";
import { testShop } from "./testing.ts";

function request(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    customerId: "cust_1",
    lines: [{ sku: "MUG-01", quantity: 1 }],
    address: { country: "GB" },
    ...overrides,
  };
}

function created(result: CreateOrderResult) {
  assert.ok(result.ok, `the order was made, but: ${result.ok ? "" : result.reason}`);
  return result;
}

describe("OrderService.createOrder", () => {
  it("makes an order with its totals, takes the stock and says so", async () => {
    const { orders, inventory, telemetry } = testShop({ stock: { "MUG-01": 5 } });
    const { order, replayed } = created(await orders.createOrder(request()));
    assert.equal(replayed, false);
    assert.equal(order.id, "ord_000001");
    assert.equal(order.subtotalCents, 1299);
    assert.equal(order.taxCents, 260);
    assert.equal(order.totalCents, 1559);
    assert.equal(order.country, "GB");
    assert.equal(await inventory.available("MUG-01"), 4);

    const types = telemetry.events.map((event) => event.type);
    assert.deepEqual(types, ["inventory.stocked", "inventory.reserved", "order.created"]);
    const event = telemetry.events.at(-1);
    assert.deepEqual(event?.attributes, {
      orderId: "ord_000001",
      customerId: "cust_1",
      idempotencyKey: null,
      lineCount: 1,
      subtotalCents: 1299,
      discountCents: 0,
      taxCents: 260,
      totalCents: 1559,
      country: "GB",
    });
  });

  it("keeps the country the order is sent to, and taxes it at that country's rate", async () => {
    const { orders } = testShop();
    const { order } = created(await orders.createOrder(request({ address: { country: "DE" } })));
    assert.equal(order.country, "DE");
    assert.equal(order.taxCents, 247);
  });

  it("takes an order that is collected in the shop, which has no address", async () => {
    const { orders } = testShop();
    const { order } = created(await orders.createOrder(request({ address: undefined })));
    assert.equal(order.country, "GB");
    assert.equal(order.taxCents, 260);
  });

  it("does not make an order that cannot be, and says why without making anything", async () => {
    const { orders, inventory, telemetry } = testShop({ stock: { "MUG-01": 5 } });
    const cases: [Partial<OrderRequest>, string][] = [
      [{ lines: [{ sku: "NOPE-1", quantity: 1 }] }, "unknown_product"],
      [{ discountCode: "FREE" }, "unknown_discount_code"],
      [{ address: { country: "ZZ" } }, "unsupported_country"],
    ];
    for (const [overrides, reason] of cases) {
      const result = await orders.createOrder(request(overrides));
      assert.deepEqual(result.ok ? null : result.reason, reason);
    }
    assert.equal(orders.countOrders("cust_1"), 0);
    assert.equal(await inventory.available("MUG-01"), 5);
    assert.deepEqual(
      telemetry.events
        .filter((event) => event.type === "order.rejected")
        .map((e) => e.attributes["reason"]),
      ["unknown_product", "unknown_discount_code", "unsupported_country"],
    );
  });

  it("gives back what it took when a later line is out of stock", async () => {
    const { orders, inventory } = testShop({ stock: { "MUG-01": 5, "POT-02": 0 } });
    const result = await orders.createOrder(
      request({
        lines: [
          { sku: "MUG-01", quantity: 2 },
          { sku: "POT-02", quantity: 1 },
        ],
      }),
    );
    assert.deepEqual(result, { ok: false, reason: "out_of_stock", sku: "POT-02" });
    assert.equal(await inventory.available("MUG-01"), 5);
    assert.equal(orders.countOrders("cust_1"), 0);
  });

  it("sells the last unit to one of two customers who ask for it together", async () => {
    const { orders, inventory } = testShop({ stock: { "POT-02": 1 } });
    const results = await Promise.all([
      orders.createOrder(request({ customerId: "a", lines: [{ sku: "POT-02", quantity: 1 }] })),
      orders.createOrder(request({ customerId: "b", lines: [{ sku: "POT-02", quantity: 1 }] })),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(
      results.filter((result) => !result.ok && result.reason === "out_of_stock").length,
      1,
    );
    assert.equal(await inventory.available("POT-02"), 0);
  });

  it("never sells more of a product than there was, however many ask together", async () => {
    const { orders, inventory, telemetry } = testShop({ stock: { "BOK-03": 4 } });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        orders.createOrder(
          request({ customerId: `c${index}`, lines: [{ sku: "BOK-03", quantity: 1 }] }),
        ),
      ),
    );
    assert.equal(results.filter((result) => result.ok).length, 4);
    const reserved = telemetry.events.filter((event) => event.type === "inventory.reserved");
    assert.equal(reserved.length, 4);
    assert.equal(await inventory.available("BOK-03"), 0);
  });
});

describe("OrderService.createOrder with an idempotency key", () => {
  it("answers the same request again with the same order, and makes no second one", async () => {
    const { orders, inventory, telemetry } = testShop({ stock: { "MUG-01": 5 } });
    const first = created(await orders.createOrder(request({ idempotencyKey: "k-1" })));
    const again = created(await orders.createOrder(request({ idempotencyKey: "k-1" })));
    assert.equal(first.replayed, false);
    assert.equal(again.replayed, true);
    assert.equal(again.order.id, first.order.id);
    assert.equal(orders.countOrders("cust_1"), 1);
    assert.equal(await inventory.available("MUG-01"), 4);
    assert.equal(telemetry.events.filter((event) => event.type === "order.created").length, 1);
  });

  it("makes one order when the same request arrives twice at once", async () => {
    const { orders, inventory } = testShop({ stock: { "MUG-01": 5 } });
    const [a, b] = await Promise.all([
      orders.createOrder(request({ idempotencyKey: "k-2" })),
      orders.createOrder(request({ idempotencyKey: "k-2" })),
    ]);
    assert.equal(created(a).order.id, created(b).order.id);
    assert.deepEqual([created(a).replayed, created(b).replayed].sort(), [false, true]);
    assert.equal(orders.countOrders("cust_1"), 1);
    assert.equal(await inventory.available("MUG-01"), 4);
  });

  it("keeps the keys of different customers apart", async () => {
    const { orders } = testShop();
    const a = created(
      await orders.createOrder(request({ customerId: "a", idempotencyKey: "same" })),
    );
    const b = created(
      await orders.createOrder(request({ customerId: "b", idempotencyKey: "same" })),
    );
    assert.notEqual(a.order.id, b.order.id);
    assert.equal(b.replayed, false);
  });

  it("lets a key try again after the request that used it failed", async () => {
    const { orders, inventory } = testShop({ stock: { "POT-02": 0 } });
    const lines = [{ sku: "POT-02", quantity: 1 }];
    const failed = await orders.createOrder(request({ lines, idempotencyKey: "k-3" }));
    assert.equal(failed.ok, false);
    await inventory.release("POT-02", 1);
    const retried = created(await orders.createOrder(request({ lines, idempotencyKey: "k-3" })));
    assert.equal(retried.replayed, false);
  });

  it("makes a new order for each request that has no key", async () => {
    const { orders } = testShop();
    await orders.createOrder(request());
    await orders.createOrder(request());
    assert.equal(orders.countOrders("cust_1"), 2);
  });
});

describe("OrderService.listOrders", () => {
  async function shopWithOrders(count: number, customerId = "cust_1") {
    const shop = testShop({ stock: { "SPN-09": 1000 } });
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const { order } = created(
        await shop.orders.createOrder(
          request({ customerId, lines: [{ sku: "SPN-09", quantity: 1 }] }),
        ),
      );
      ids.push(order.id);
    }
    return { ...shop, ids };
  }

  it("lists the newest first", async () => {
    const { orders, ids } = await shopWithOrders(3);
    assert.deepEqual(
      orders.listOrders("cust_1", 1, 10).map((order) => order.id),
      [...ids].reverse(),
    );
  });

  it("shows every order exactly once across the pages", async () => {
    const { orders, ids } = await shopWithOrders(25);
    const pages = [1, 2, 3].map((page) =>
      orders.listOrders("cust_1", page, 10).map((order) => order.id),
    );
    assert.deepEqual(
      pages.map((page) => page.length),
      [10, 10, 5],
    );
    assert.deepEqual(pages.flat(), [...ids].reverse());
    assert.deepEqual(orders.listOrders("cust_1", 4, 10), []);
  });

  it("starts the first page at the newest order and ends the last page at the oldest", async () => {
    const { orders, ids } = await shopWithOrders(20);
    assert.equal(orders.listOrders("cust_1", 1, 10)[0]?.id, ids.at(-1));
    assert.equal(orders.listOrders("cust_1", 2, 10).at(-1)?.id, ids[0]);
  });

  it("copes when the orders fill the pages exactly, and with a page of one", async () => {
    const { orders, ids } = await shopWithOrders(10);
    assert.equal(orders.listOrders("cust_1", 1, 10).length, 10);
    assert.deepEqual(orders.listOrders("cust_1", 2, 10), []);
    assert.deepEqual(
      [1, 2, 3].map((page) => orders.listOrders("cust_1", page, 1)[0]?.id),
      [ids[9], ids[8], ids[7]],
    );
  });

  it("lists only the orders of the customer asked about", async () => {
    const { orders } = await shopWithOrders(3, "cust_1");
    assert.deepEqual(orders.listOrders("someone-else", 1, 10), []);
    assert.equal(orders.countOrders("someone-else"), 0);
    assert.equal(orders.countOrders("cust_1"), 3);
  });
});
