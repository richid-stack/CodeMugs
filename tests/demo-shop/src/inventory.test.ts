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
