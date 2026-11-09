import {
  eventEnvelopeSchema,
  MAX_EVENTS_PER_BATCH,
  type EventEnvelope,
} from "@codemugs/event-schemas";

/**
 * Why one event was turned away. These are stable codes for SDK authors and never contain any of
 * the event's own content: a rejected event may hold anything, including personal data.
 */
export type RejectionReason =
  /** The item is not a JSON object. */
  | "not_an_object"
  /** It does not match the event schema. `field` names the top-level field at fault. */
  | "invalid_event"
  /** `occurredAt` is before 2000 or more than a day in the future. */
  | "occurred_at_out_of_range"
  /** `attributes` is nested deeper than {@link MAX_ATTRIBUTE_DEPTH}. */
  | "attributes_too_deep"
  /** A string holds a NUL character or a lone surrogate, or a number is not finite. */
  | "unsupported_value";

export interface Rejection {
  reason: RejectionReason;
  field?: string;
}

export type BatchShapeError =
  "body_not_an_object" | "events_missing" | "events_empty" | "too_many_events";

/** Events older than this cannot be real, and year 0000 is a value PostgreSQL refuses. */
export const EARLIEST_OCCURRED_AT = new Date("2000-01-01T00:00:00.000Z");
/** Clocks drift, but an event from beyond this far ahead is wrong and would skew time windows. */
export const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
/** Deep enough for a stack trace with local variables, shallow enough to be cheap everywhere. */
export const MAX_ATTRIBUTE_DEPTH = 20;

/** With the `u` flag a surrogate pair is one code point, so this matches only a lone surrogate. */
const LONE_SURROGATE = /\p{Surrogate}/u;

/** A NUL cannot be stored in PostgreSQL text, and a lone surrogate cannot be stored in jsonb. */
function isUnstorableText(text: string): boolean {
  return text.includes("\u0000") || LONE_SURROGATE.test(text);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks the outer shape of a request body: `{ "events": [ ... ] }` with 1 to 500 items. */
export function checkBatchShape(
  body: unknown,
): { items: readonly unknown[] } | { error: BatchShapeError } {
  if (!isPlainObject(body)) return { error: "body_not_an_object" };
  const events = body["events"];
  if (!Array.isArray(events)) return { error: "events_missing" };
  if (events.length === 0) return { error: "events_empty" };
  if (events.length > MAX_EVENTS_PER_BATCH) return { error: "too_many_events" };
  return { items: events as unknown[] };
}

/**
 * Walks a value that came out of JSON.parse and reports what would stop it being stored. It uses
 * an explicit stack, so a hostile document cannot overflow the call stack, and it stops at the
 * depth limit before PostgreSQL's own parser would have to deal with the nesting.
 */
function storability(root: unknown): "ok" | "attributes_too_deep" | "unsupported_value" {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };
    if (typeof value === "string") {
      if (isUnstorableText(value)) return "unsupported_value";
    } else if (typeof value === "number") {
      // JSON.parse turns 1e999 into Infinity, which JSON.stringify would silently store as null.
      if (!Number.isFinite(value)) return "unsupported_value";
    } else if (Array.isArray(value)) {
      if (depth + 1 > MAX_ATTRIBUTE_DEPTH) return "attributes_too_deep";
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
    } else if (typeof value === "object" && value !== null) {
      if (depth + 1 > MAX_ATTRIBUTE_DEPTH) return "attributes_too_deep";
      for (const [key, item] of Object.entries(value)) {
        if (isUnstorableText(key)) return "unsupported_value";
        stack.push({ value: item, depth: depth + 1 });
      }
    }
  }
  return "ok";
}

/**
 * Decides whether one event can be stored, and returns it in the form that will be stored.
 *
 * The promise this function makes is the one ingestion depends on: an event it accepts will not
 * make the database fail. A request that fails in the database is retried by the client, so one
 * event that can never be stored would block its whole batch for ever. Anything that would do
 * that is turned into a rejection of that one event instead.
 */
export function validateEvent(
  item: unknown,
  now: Date,
): { event: EventEnvelope } | { rejection: Rejection } {
  if (!isPlainObject(item)) return { rejection: { reason: "not_an_object" } };

  const parsed = eventEnvelopeSchema.safeParse(item);
  if (!parsed.success) {
    // Only the first path segment is reported. It is always a field of the schema, because
    // unknown keys are stripped rather than rejected. Deeper segments can be client-chosen keys.
    const first = parsed.error.issues[0]?.path[0];
    return {
      rejection: { reason: "invalid_event", field: typeof first === "string" ? first : "event" },
    };
  }
  const event = parsed.data;

  const occurredAt = new Date(event.occurredAt);
  if (
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt < EARLIEST_OCCURRED_AT ||
    occurredAt.getTime() > now.getTime() + MAX_FUTURE_MS
  ) {
    return { rejection: { reason: "occurred_at_out_of_range", field: "occurredAt" } };
  }

  // `attributes` is level 1 of the depth limit.
  const inAttributes = storability(event.attributes);
  if (inAttributes !== "ok") {
    return { rejection: { reason: inAttributes, field: "attributes" } };
  }
  if (storability(event.sdk) !== "ok") {
    return { rejection: { reason: "unsupported_value", field: "sdk" } };
  }

  return { event };
}
