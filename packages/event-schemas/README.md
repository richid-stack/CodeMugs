# @codemugs/event-schemas

Wire-format schemas for events entering the platform.

**Status:** Phase 1 · Foundation (started). The envelope is a starting point and will evolve with the SDKs in Phase 2.

- `eventEnvelopeSchema`: one event. Client-generated `eventId` (UUID) is the idempotency key, so retried batches are safe.
- `eventBatchSchema`: 1 to 500 events per request.

## Rules encoded here

- **No tenant or project in the payload.** Gateways derive tenant identity from the authenticated credential. Unknown keys, including any `tenantId` a client sends, are stripped. This is covered by a test.
- **Strict shapes.** Event types follow a fixed naming pattern, timestamps must be ISO 8601 with an offset, and the schema version is explicit.
- **Size is a gateway concern.** Payload size limits are enforced at the gateway body limit, not in this schema.
