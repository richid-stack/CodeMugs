import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Inventory, MemoryStockStore } from "./inventory.ts";

function inventoryWith(stock: Record<string, number>): Inventory {
  return new Inventory(new MemoryStockStore(stock));
}

describe("Inventory", () => {
  it("takes units that are there, and says how many are left", async () => {
    const inventory = inventoryWith({ A: 5 });
    assert.equal(await inventory.reserve("A", 2), true);
    assert.equal(await inventory.available("A"), 3);
    assert.equal(await inventory.reserve("A", 3), true);
    assert.equal(await inventory.available("A"), 0);
  });

  it("takes nothing when there are not enough, not even what there is", async () => {
    const inventory = inventoryWith({ A: 2 });
    assert.equal(await inventory.reserve("A", 3), false);
    assert.equal(await inventory.available("A"), 2);
  });

  it("has none of a product it was not given", async () => {
    const inventory = inventoryWith({ A: 2 });
    assert.equal(await inventory.available("B"), 0);
    assert.equal(await inventory.reserve("B", 1), false);
    assert.equal(await inventory.available("B"), 0);
  });

  it("puts units back", async () => {
    const inventory = inventoryWith({ A: 2 });
    await inventory.reserve("A", 2);
    await inventory.release("A", 2);
    assert.equal(await inventory.available("A"), 2);
  });

  it("does not sell the same unit twice when requests arrive together", async () => {
    const inventory = inventoryWith({ A: 3 });
    const results = await Promise.all(Array.from({ length: 10 }, () => inventory.reserve("A", 1)));
    assert.equal(results.filter(Boolean).length, 3);
    assert.equal(await inventory.available("A"), 0);
  });

  it("does not lose units that are put back while others are taken", async () => {
    const inventory = inventoryWith({ A: 10 });
    await Promise.all([
      ...Array.from({ length: 5 }, () => inventory.reserve("A", 1)),
      ...Array.from({ length: 5 }, () => inventory.release("A", 1)),
    ]);
    assert.equal(await inventory.available("A"), 10);
  });
});

describe("MemoryStockStore with a latency", () => {
  it("answers each call after the latency, and not before", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const store = new MemoryStockStore({ A: 5 }, 10);
    const calls: [string, () => Promise<unknown>][] = [
      ["get", () => store.get("A")],
      ["set", () => store.set("A", 5)],
      ["add", () => store.add("A", 0)],
      ["takeIfAvailable", () => store.takeIfAvailable("A", 0)],
    ];
    for (const [name, call] of calls) {
      let answered = false;
      const pending = call().then(() => {
        answered = true;
      });
      context.mock.timers.tick(9);
      // Only setTimeout is faked, so this lets every promise that can settle settle.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(answered, false, `${name} answered early`);
      context.mock.timers.tick(1);
      await pending;
      assert.equal(answered, true, name);
    }
  });

  it("does what it is asked at once, so that calls that overlap in time see each other's work", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const store = new MemoryStockStore({ A: 5 }, 10);
    const first = store.set("A", 1);
    const second = store.get("A");
    const third = store.add("A", 2);
    const fourth = store.get("A");
    const fifth = store.takeIfAvailable("A", 3);
    const sixth = store.get("A");
    context.mock.timers.tick(10);
    assert.deepEqual(await Promise.all([first, second, third, fourth, fifth, sixth]), [
      undefined,
      1,
      undefined,
      3,
      true,
      0,
    ]);
  });

  it("gives other work a turn when it has no latency", async () => {
    const store = new MemoryStockStore({ A: 5 });
    const order: string[] = [];
    const reading = store.get("A").then(() => order.push("answered"));
    order.push("asked");
    await reading;
    assert.deepEqual(order, ["asked", "answered"]);
  });

  it("sells no unit twice when ten ask together of a store that takes time to answer", async () => {
    const inventory = new Inventory(new MemoryStockStore({ A: 3 }, 5));
    const results = await Promise.all(Array.from({ length: 10 }, () => inventory.reserve("A", 1)));
    assert.equal(results.filter(Boolean).length, 3);
    assert.equal(await inventory.available("A"), 0);
  });
});
