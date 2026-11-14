import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findProduct, PRODUCTS, type Product } from "./catalog.ts";
import { PICKUP_COUNTRY, priceOrder, type RequestedLine } from "./pricing.ts";

function product(sku: string): Product {
  const found = findProduct(sku);
  assert.ok(found, `${sku} is in the catalogue`);
  return found;
}

const mug = product("MUG-01"); // 1299
const spoon = product("SPN-09"); // 199

function line(p: Product, quantity: number): RequestedLine {
  return { product: p, quantity };
}

function priced(...args: Parameters<typeof priceOrder>) {
  const result = priceOrder(...args);
  assert.ok(result.ok, "the order is priced");
  return result.totals;
}

describe("priceOrder", () => {
  it("adds up the lines, takes tax on them and gives the total", () => {
    const totals = priced([line(mug, 2), line(spoon, 3)], undefined, "GB");
    assert.deepEqual(
      totals.lines.map((l) => l.lineCents),
      [2598, 597],
    );
    assert.equal(totals.subtotalCents, 3195);
    assert.equal(totals.discountCents, 0);
    assert.equal(totals.taxCents, 639); // 20% of 3195 is 639
    assert.equal(totals.totalCents, 3834);
  });

  it("uses the rate of the country the order is sent to", () => {
    const cart = [line(mug, 1)];
    assert.equal(priced(cart, undefined, "DE").taxCents, 247); // 19% of 1299 is 246.81
    assert.equal(priced(cart, undefined, "FR").taxCents, 260); // 20% is 259.8
    assert.equal(priced(cart, undefined, "US").taxCents, 0);
    assert.equal(priced(cart, undefined, PICKUP_COUNTRY).taxCents, 260);
  });

  it("works out the tax once for the order, not once for each line", () => {
    // Three lines of 199 at 20%: 119.4 for the order, which is 119, and 39.8 for each line, which
    // is 40 each and 120 together. The order is what is taxed.
    const totals = priced([line(spoon, 1), line(spoon, 1), line(spoon, 1)], undefined, "GB");
    assert.equal(totals.subtotalCents, 597);
    assert.equal(totals.taxCents, 119);
    assert.equal(totals.totalCents, 716);
  });

  it("takes a flat discount off before the tax", () => {
    const totals = priced([line(mug, 1)], "WELCOME5", "GB");
    assert.equal(totals.discountCents, 500);
    assert.equal(totals.taxCents, 160); // 20% of 799
    assert.equal(totals.totalCents, 959);
  });

  it("takes a percentage off, rounded half up, before the tax", () => {
    const totals = priced([line(mug, 1)], "SPRING10", "GB");
    assert.equal(totals.discountCents, 130); // 129.9
    assert.equal(totals.taxCents, 234); // 20% of 1169 is 233.8
    assert.equal(totals.totalCents, 1403);
  });

  it("never takes off more than the order costs, so that the total is not negative", () => {
    const totals = priced([line(spoon, 1)], "WELCOME5", "GB");
    assert.equal(totals.subtotalCents, 199);
    assert.equal(totals.discountCents, 199);
    assert.equal(totals.taxCents, 0);
    assert.equal(totals.totalCents, 0);
  });

  it("refuses a discount code it does not know, and a country it has no rate for", () => {
    assert.deepEqual(priceOrder([line(mug, 1)], "FREE", "GB"), {
      ok: false,
      reason: "unknown_discount_code",
    });
    assert.deepEqual(priceOrder([line(mug, 1)], undefined, "ZZ"), {
      ok: false,
      reason: "unsupported_country",
    });
    // Codes are exact: upper case, as given.
    assert.equal(priceOrder([line(mug, 1)], "welcome5", "GB").ok, false);
  });

  it("holds for every small cart, code and country: whole numbers, a sum that adds up, never negative", () => {
    for (const first of PRODUCTS) {
      for (const second of PRODUCTS) {
        for (const quantity of [1, 2, 3, 7]) {
          for (const code of [undefined, "WELCOME5", "SPRING10"]) {
            for (const country of ["GB", "DE", "FR", "US"]) {
              const t = priced([line(first, quantity), line(second, 1)], code, country);
              const where = `${first.sku}x${quantity} ${second.sku} ${code ?? "-"} ${country}`;
              for (const value of [t.subtotalCents, t.discountCents, t.taxCents, t.totalCents]) {
                assert.ok(Number.isInteger(value), `whole numbers: ${where}`);
              }
              assert.ok(t.discountCents >= 0 && t.discountCents <= t.subtotalCents, where);
              assert.ok(t.taxCents >= 0, where);
              assert.equal(t.totalCents, t.subtotalCents - t.discountCents + t.taxCents, where);
              assert.ok(t.totalCents >= 0, where);
            }
          }
        }
      }
    }
  });
});
