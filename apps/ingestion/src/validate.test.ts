import { describe, expect, it } from "vitest";
import { MAX_EVENTS_PER_BATCH } from "@codemugs/event-schemas";
import {
  checkBatchShape,
  EARLIEST_OCCURRED_AT,
  MAX_ATTRIBUTE_DEPTH,
  MAX_FUTURE_MS,
  validateEvent,
} from "./validate.js";

const NOW = new Date("2026-11-08T12:00:00.000Z");

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId: "0c5b8a2e-7c0b-4a39-9f43-1b9f2d7e6a10",
    type: "checkout.completed",
    occurredAt: "2026-11-08T11:59:00Z",
    environment: "production",
    sdk: { name: "sdk-js", version: "1.2.3" },
    attributes: { orderId: "o-1", total: 12.5, items: [1, 2, 3] },
    ...overrides,
  };
}

/** `depth` nested objects, the outermost being the value of `attributes`. */
function nested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let level = 1; level < depth; level += 1) value = { a: value };
  return value;
}

function rejection(item: unknown, now = NOW) {
  const result = validateEvent(item, now);
  if ("event" in result) throw new Error("expected the event to be rejected");
  return result.rejection;
}

describe("checkBatchShape", () => {
  it.each([
    ["null", null],
    ["a string", "events"],
    ["a number", 7],
    ["an array", [event()]],
  ])("rejects %s as a body", (_label, body) => {
    expect(checkBatchShape(body)).toEqual({ error: "body_not_an_object" });
  });

  it.each([
    ["no events key", {}],
    ["events that is not an array", { events: "x" }],
    ["events that is an object", { events: { 0: event() } }],
    ["events that is null", { events: null }],
  ])("rejects %s", (_label, body) => {
    expect(checkBatchShape(body)).toEqual({ error: "events_missing" });
  });

  it("rejects an empty batch", () => {
    expect(checkBatchShape({ events: [] })).toEqual({ error: "events_empty" });
  });

  it("accepts the largest batch and rejects one more", () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH }, () => event());
    expect(checkBatchShape({ events })).toEqual({ items: events });
    expect(checkBatchShape({ events: [...events, event()] })).toEqual({
      error: "too_many_events",
    });
  });

  it("hands back items of any kind so each can be judged on its own", () => {
    const items = [event(), null, 7, "x"];
    expect(checkBatchShape({ events: items, extra: true })).toEqual({ items });
  });
});

describe("validateEvent", () => {
  it("accepts a well-formed event", () => {
    const result = validateEvent(event(), NOW);
    expect(result).toMatchObject({
      event: { eventId: "0c5b8a2e-7c0b-4a39-9f43-1b9f2d7e6a10", type: "checkout.completed" },
    });
  });

  it("strips anything that names a tenant instead of trusting it", () => {
    const result = validateEvent(
      event({
        organisationId: "x",
        organizationId: "x",
        projectId: "x",
        tenantId: "x",
        apiKeyId: "x",
      }),
      NOW,
    );
    expect(result).toHaveProperty("event");
    if (!("event" in result)) return;
    expect(Object.keys(result.event).sort()).toEqual([
      "attributes",
      "environment",
      "eventId",
      "occurredAt",
      "schemaVersion",
      "sdk",
      "type",
    ]);
  });

  it("defaults missing attributes to an empty object", () => {
    const withoutAttributes = event();
    delete withoutAttributes["attributes"];
    expect(validateEvent(withoutAttributes, NOW)).toMatchObject({ event: { attributes: {} } });
  });

  it("accepts an upper-case event id", () => {
    expect(
      validateEvent(event({ eventId: "0C5B8A2E-7C0B-4A39-9F43-1B9F2D7E6A10" }), NOW),
    ).toHaveProperty("event");
  });

  describe("an item that is not an event", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["a number", 1],
      ["a string", "event"],
      ["an array", [event()]],
      ["a boolean", true],
    ])("rejects %s", (_label, item) => {
      expect(rejection(item)).toEqual({ reason: "not_an_object" });
    });
  });

  describe("a schema violation", () => {
    it.each([
      ["a missing eventId", { eventId: undefined }, "eventId"],
      ["an eventId that is not a UUID", { eventId: "not-a-uuid" }, "eventId"],
      ["an eventId of the wrong type", { eventId: 7 }, "eventId"],
      ["an upper-case type", { type: "Checkout.Completed" }, "type"],
      ["an empty type", { type: "" }, "type"],
      ["a type that is too long", { type: `a${"b".repeat(128)}` }, "type"],
      ["a timestamp with no offset", { occurredAt: "2026-11-08T11:59:00" }, "occurredAt"],
      ["a timestamp that is not a date", { occurredAt: "yesterday" }, "occurredAt"],
      ["an unknown environment", { environment: "prod" }, "environment"],
      ["a missing sdk", { sdk: undefined }, "sdk"],
      ["an sdk with no name", { sdk: { version: "1" } }, "sdk"],
      ["an unsupported schema version", { schemaVersion: 2 }, "schemaVersion"],
      ["attributes that are an array", { attributes: [1] }, "attributes"],
      ["attributes that are a string", { attributes: "x" }, "attributes"],
      ["an attribute key that is too long", { attributes: { ["k".repeat(129)]: 1 } }, "attributes"],
    ])("rejects %s and names only the field", (_label, overrides, field) => {
      expect(rejection(event(overrides))).toEqual({ reason: "invalid_event", field });
    });

    it("never repeats a client-chosen key or value in the rejection", () => {
      const hostile = "secret-attribute-key-".repeat(10);
      const found = rejection(event({ attributes: { [hostile]: 1 } }));
      expect(JSON.stringify(found)).not.toContain("secret-attribute-key");
    });
  });

  describe("the timestamp window", () => {
    const at = (occurredAt: string) => validateEvent(event({ occurredAt }), NOW);

    it("rejects year 0000, which the schema allows and PostgreSQL does not", () => {
      expect(rejection(event({ occurredAt: "0000-01-01T00:00:00Z" }))).toEqual({
        reason: "occurred_at_out_of_range",
        field: "occurredAt",
      });
    });

    it("rejects the instant before 2000 and accepts the first instant of it", () => {
      expect(at("1999-12-31T23:59:59.999Z")).toHaveProperty("rejection");
      expect(at(EARLIEST_OCCURRED_AT.toISOString())).toHaveProperty("event");
    });

    it("accepts up to a day ahead of now and rejects anything later", () => {
      const limit = new Date(NOW.getTime() + MAX_FUTURE_MS);
      expect(at(limit.toISOString())).toHaveProperty("event");
      expect(at(new Date(limit.getTime() + 1).toISOString())).toHaveProperty("rejection");
      expect(at("9999-12-31T23:59:59Z")).toHaveProperty("rejection");
    });

    it("compares the instant, not the text, so an offset cannot slip past the limit", () => {
      // 13:00 at +14:00 is 23:00 the day before.
      expect(at("2026-11-09T13:00:00+14:00")).toHaveProperty("event");
      // The same wall-clock time at -12:00 is 37 hours after NOW.
      expect(at("2026-11-09T13:00:00-12:00")).toHaveProperty("rejection");
    });
  });

  describe("values that cannot be stored", () => {
    const unsupported = (overrides: Record<string, unknown>, field: string) =>
      expect(rejection(event(overrides))).toEqual({ reason: "unsupported_value", field });

    it("rejects a NUL character in an attribute value, key, nested value or array item", () => {
      unsupported({ attributes: { a: "x\u0000y" } }, "attributes");
      unsupported({ attributes: { "k\u0000": 1 } }, "attributes");
      unsupported({ attributes: { a: { b: { c: "\u0000" } } } }, "attributes");
      unsupported({ attributes: { a: [1, [2, "\u0000"]] } }, "attributes");
    });

    it("rejects a lone surrogate, high or low, in a value or a key", () => {
      unsupported({ attributes: { a: "\ud800" } }, "attributes");
      unsupported({ attributes: { a: "x\udc00y" } }, "attributes");
      unsupported({ attributes: { ["\ud83d"]: 1 } }, "attributes");
    });

    it("accepts a proper surrogate pair and other multi-byte text", () => {
      expect(validateEvent(event({ attributes: { a: "😀 ñ 日本語" } }), NOW)).toHaveProperty(
        "event",
      );
    });

    it("rejects a NUL or lone surrogate in the sdk fields", () => {
      unsupported({ sdk: { name: "sdk\u0000", version: "1" } }, "sdk");
      unsupported({ sdk: { name: "sdk", version: "\ud800" } }, "sdk");
    });

    it("rejects a number that is not finite", () => {
      // JSON.parse turns 1e999 into Infinity, and JSON.stringify would store that as null.
      const parsed = JSON.parse('{"big": 1e999}') as Record<string, unknown>;
      unsupported({ attributes: parsed }, "attributes");
      unsupported({ attributes: { n: Number.NaN } }, "attributes");
      unsupported({ attributes: { list: [1, Number.NEGATIVE_INFINITY] } }, "attributes");
    });

    it("accepts large but finite numbers, booleans and null", () => {
      expect(
        validateEvent(event({ attributes: { a: 1e308, b: -1e308, c: true, d: null } }), NOW),
      ).toHaveProperty("event");
    });
  });

  describe("nesting", () => {
    it("accepts attributes nested to the limit and rejects one level more", () => {
      expect(validateEvent(event({ attributes: nested(MAX_ATTRIBUTE_DEPTH) }), NOW)).toHaveProperty(
        "event",
      );
      expect(rejection(event({ attributes: nested(MAX_ATTRIBUTE_DEPTH + 1) }))).toEqual({
        reason: "attributes_too_deep",
        field: "attributes",
      });
    });

    it("counts arrays as levels too", () => {
      let value: unknown = [];
      for (let level = 1; level <= MAX_ATTRIBUTE_DEPTH; level += 1) value = [value];
      expect(rejection(event({ attributes: { list: value } })).reason).toBe("attributes_too_deep");
    });

    it("rejects an absurdly deep document without overflowing the stack", () => {
      expect(rejection(event({ attributes: nested(200_000) })).reason).toBe("attributes_too_deep");
    });
  });

  describe("an attribute named __proto__", () => {
    it("is dropped, and does not change what every other object inherits", () => {
      const parsed = JSON.parse('{"__proto__": {"polluted": true}, "kept": 1}') as Record<
        string,
        unknown
      >;
      const result = validateEvent(event({ attributes: parsed }), NOW);
      expect(result).toMatchObject({ event: { attributes: { kept: 1 } } });
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    });
  });
});
