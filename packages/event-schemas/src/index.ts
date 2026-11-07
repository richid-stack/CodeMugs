import { z } from "zod";

export const EVENT_SCHEMA_VERSION = 1;
export const MAX_EVENTS_PER_BATCH = 500;
export const ENVIRONMENTS = ["production", "staging", "development", "test"] as const;

/**
 * Wire format for a single event sent by an SDK, connector or gateway.
 *
 * Tenant and project identity are deliberately NOT part of this schema. Gateways derive
 * them from the authenticated credential, never from the payload. Unknown keys (including
 * any `tenantId` a client tries to smuggle in) are stripped during parsing.
 *
 * Payload size is bounded by the gateway's request body limit, not by this schema.
 */
export const eventEnvelopeSchema = z.object({
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  /** Client-generated; doubles as the idempotency key so retried batches are safe. */
  eventId: z.uuid(),
  /** Dot-separated lowercase name, e.g. "error.captured" or "checkout.completed". */
  type: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/),
  /** When the event happened on the client, ISO 8601 with offset. */
  occurredAt: z.iso.datetime({ offset: true }),
  environment: z.enum(ENVIRONMENTS),
  sdk: z.object({
    name: z.string().min(1).max(64),
    version: z.string().min(1).max(32),
  }),
  attributes: z.record(z.string().max(128), z.unknown()).default({}),
});

export type EventEnvelope = z.output<typeof eventEnvelopeSchema>;

export const eventBatchSchema = z.object({
  events: z.array(eventEnvelopeSchema).min(1).max(MAX_EVENTS_PER_BATCH),
});

export type EventBatch = z.output<typeof eventBatchSchema>;
