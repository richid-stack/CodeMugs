import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseOrderRequest } from "./requests.ts";

const valid = {
  customerId: "cust_1",
  lines: [{ sku: "MUG-01", quantity: 2 }],
  address: { country: "DE" },
  discountCode: "SPRING10",
};

describe("parseOrderRequest", () => {
  it("accepts a whole request, and one with only what is needed", () => {
    assert.deepEqual(parseOrderRequest(valid, "key-1"), {
      ok: true,
      request: { ...valid, idempotencyKey: "key-1" },
    });
    assert.deepEqual(parseOrderRequest({ customerId: "c", lines: [{ sku: "A", quantity: 1 }] }), {
      ok: true,
      request: { customerId: "c", lines: [{ sku: "A", quantity: 1 }] },
    });
  });

  it("leaves out what it was not asked to read", () => {
    const result = parseOrderRequest({ ...valid, tenantId: "other", isAdmin: true });
    assert.ok(result.ok);
    assert.deepEqual(Object.keys(result.request).sort(), [
      "address",
      "customerId",
      "discountCode",
      "lines",
    ]);
  });

  const bad: [string, unknown, string | undefined, string][] = [
    ["a body that is not an object", "text", undefined, "body"],
    ["a body that is a list", [], undefined, "body"],
    ["a missing customer", { ...valid, customerId: undefined }, undefined, "customerId"],
    ["a customer with odd characters", { ...valid, customerId: "a b" }, undefined, "customerId"],
    [
      "a customer that is too long",
      { ...valid, customerId: "a".repeat(65) },
      undefined,
      "customerId",
    ],
    ["no lines", { ...valid, lines: [] }, undefined, "lines"],
    [
      "too many lines",
      { ...valid, lines: Array(51).fill({ sku: "A", quantity: 1 }) },
      undefined,
      "lines",
    ],
    ["a line that is not an object", { ...valid, lines: ["MUG-01"] }, undefined, "lines"],
    [
      "a sku in lower case",
      { ...valid, lines: [{ sku: "mug-01", quantity: 1 }] },
      undefined,
      "lines.sku",
    ],
    [
      "a quantity of zero",
      { ...valid, lines: [{ sku: "A", quantity: 0 }] },
      undefined,
      "lines.quantity",
    ],
    [
      "a quantity above 99",
      { ...valid, lines: [{ sku: "A", quantity: 100 }] },
      undefined,
      "lines.quantity",
    ],
    [
      "a quantity with a fraction",
      { ...valid, lines: [{ sku: "A", quantity: 1.5 }] },
      undefined,
      "lines.quantity",
    ],
    [
      "a quantity that is text",
      { ...valid, lines: [{ sku: "A", quantity: "2" }] },
      undefined,
      "lines.quantity",
    ],
    ["an address that is text", { ...valid, address: "Berlin" }, undefined, "address"],
    [
      "a country in lower case",
      { ...valid, address: { country: "de" } },
      undefined,
      "address.country",
    ],
    [
      "a country of three letters",
      { ...valid, address: { country: "DEU" } },
      undefined,
      "address.country",
    ],
    ["a discount code that is not text", { ...valid, discountCode: 5 }, undefined, "discountCode"],
    [
      "a discount code that is too long",
      { ...valid, discountCode: "X".repeat(33) },
      undefined,
      "discountCode",
    ],
    ["an empty key", valid, "", "Idempotency-Key"],
    ["a key that is too long", valid, "k".repeat(129), "Idempotency-Key"],
  ];
  for (const [name, body, key, field] of bad) {
    it(`refuses ${name}, naming the field`, () => {
      assert.deepEqual(parseOrderRequest(body, key), { ok: false, field });
    });
  }

  it("never repeats what it was sent", () => {
    const result = parseOrderRequest({ ...valid, customerId: "<script>alert('x')</script>" });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes("script"));
  });
});
