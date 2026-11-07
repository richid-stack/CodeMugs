import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_EVENTS_PER_BATCH, eventBatchSchema, eventEnvelopeSchema } from "./index.js";

function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    type: "error.captured",
    occurredAt: "2026-11-07T08:00:00.000Z",
    environment: "production",
    sdk: { name: "codemugs-js", version: "0.1.0" },
    ...overrides,
  };
}

describe("eventEnvelopeSchema", () => {
  it("accepts a valid event and defaults attributes to an empty object", () => {
    const parsed = eventEnvelopeSchema.parse(validEvent());
    expect(parsed.attributes).toEqual({});
  });

  it("rejects an unsupported schema version", () => {
    expect(eventEnvelopeSchema.safeParse(validEvent({ schemaVersion: 2 })).success).toBe(false);
  });

  it("rejects a malformed event id", () => {
    expect(eventEnvelopeSchema.safeParse(validEvent({ eventId: "not-a-uuid" })).success).toBe(
      false,
    );
  });

  it("rejects event types outside the allowed naming pattern", () => {
    expect(eventEnvelopeSchema.safeParse(validEvent({ type: "Error Captured!" })).success).toBe(
      false,
    );
  });

  it("rejects timestamps that are not ISO 8601 with an offset", () => {
    expect(eventEnvelopeSchema.safeParse(validEvent({ occurredAt: "yesterday" })).success).toBe(
      false,
    );
    expect(
      eventEnvelopeSchema.safeParse(validEvent({ occurredAt: "2026-11-07T08:00:00" })).success,
    ).toBe(false);
  });

  it("strips tenant identity a client tries to smuggle into the payload", () => {
    const parsed = eventEnvelopeSchema.parse(
      validEvent({ tenantId: "someone-else", projectId: "p1" }),
    );
    expect(parsed).not.toHaveProperty("tenantId");
    expect(parsed).not.toHaveProperty("projectId");
  });
});

describe("eventBatchSchema", () => {
  it("rejects an empty batch", () => {
    expect(eventBatchSchema.safeParse({ events: [] }).success).toBe(false);
  });

  it("accepts a batch at the size limit and rejects one over it", () => {
    const atLimit = Array.from({ length: MAX_EVENTS_PER_BATCH }, () =>
      validEvent({ eventId: randomUUID() }),
    );
    expect(eventBatchSchema.safeParse({ events: atLimit }).success).toBe(true);

    const overLimit = [...atLimit, validEvent({ eventId: randomUUID() })];
    expect(eventBatchSchema.safeParse({ events: overLimit }).success).toBe(false);
  });
});
