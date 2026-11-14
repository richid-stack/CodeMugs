import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { basisPointsOf, formatCents } from "./money.ts";

describe("basisPointsOf", () => {
  it("takes a share of an amount", () => {
    assert.equal(basisPointsOf(10_000, 2000), 2000);
    assert.equal(basisPointsOf(2598, 1000), 260);
    assert.equal(basisPointsOf(0, 1900), 0);
    assert.equal(basisPointsOf(12_345, 0), 0);
    assert.equal(basisPointsOf(12_345, 10_000), 12_345);
  });

  it("rounds half up, and only half and above", () => {
    // 0.5 of a cent goes up, 0.4999 does not.
    assert.equal(basisPointsOf(5, 1000), 1);
    assert.equal(basisPointsOf(4, 1000), 0);
    assert.equal(basisPointsOf(15, 1000), 2);
    assert.equal(basisPointsOf(14, 1000), 1);
    assert.equal(basisPointsOf(2338, 1900), 444);
    // The closest to a half on either side: 0.4999 of a cent and exactly 0.5.
    assert.equal(basisPointsOf(4999, 1), 0);
    assert.equal(basisPointsOf(5000, 1), 1);
  });

  it("gives a whole number whatever it is given", () => {
    for (let amount = 0; amount < 500; amount += 7) {
      for (const basisPoints of [1, 999, 1000, 1900, 2000, 7777]) {
        assert.ok(Number.isInteger(basisPointsOf(amount, basisPoints)));
      }
    }
  });
});

describe("formatCents", () => {
  it("writes the whole part and two digits of cents", () => {
    assert.equal(formatCents(1299), "12.99");
    assert.equal(formatCents(5), "0.05");
    assert.equal(formatCents(0), "0.00");
    assert.equal(formatCents(100), "1.00");
    assert.equal(formatCents(1_000_000), "10000.00");
  });

  it("writes a minus sign before a negative amount", () => {
    assert.equal(formatCents(-250), "-2.50");
    assert.equal(formatCents(-5), "-0.05");
  });
});
