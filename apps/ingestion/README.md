# @codemugs/ingestion

Validates events and records them durably. A library for now, used by the [API](../api/README.md) for `POST /v1/events`. A separate gateway process (the OpenTelemetry endpoint, its own scaling) is planned and can use the same code.

**Status:** Phase 1 · Foundation (started). Validation and storage exist. Processing events (jobs, workers, replay), redaction, rate limits and quotas do not. Decision: [ADR 0011](../../docs/architecture/decisions/0011-event-ingestion.md).

## Interface

- `recordEvents(pool, scope, body)`: validates a request body of events and stores them. `scope` is `{ organisationId, projectId, apiKeyId }` and must come from the authenticated credential. Returns `{ ok: true, result }` with one result per event, in order, or `{ ok: false, error }` when the body as a whole is unusable (`body_not_an_object`, `events_missing`, `events_empty`, `too_many_events`). It **throws** when the database fails, so a caller answers `5xx` and the client retries.
- `validateEvent(item, now)` and `checkBatchShape(body)`: the validation on its own, with no database.

Each event ends up `accepted`, `duplicate` (already stored, or earlier in the same batch) or `rejected`. A rejection carries a stable `reason` and, where it helps, the top-level `field`, and never a value from the event:

| Reason                     | Meaning                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `not_an_object`            | The item is not a JSON object                                                               |
| `invalid_event`            | It does not match the [event schema](../../packages/event-schemas); `field` names the field |
| `occurred_at_out_of_range` | Before 2000, or more than a day ahead of the server                                         |
| `attributes_too_deep`      | `attributes` nests more than 20 levels                                                      |
| `unsupported_value`        | A NUL or a lone surrogate in a string or key, or a number that is not finite                |

## What it guarantees

- **Nothing a client sends can make the database fail**, so one bad event never blocks a batch that is being retried. This is tested with a real PostgreSQL against values the schema accepts and the database refuses.
- **A retry is safe**: the same batch twice, the same batch twice at once, and overlapping batches in opposite orders each store every event exactly once and never deadlock.
- **The tenant comes from `scope`.** The event schema strips anything in a payload that names a tenant, and a test checks the stored row.

## What it does not do

- It does not redact. Attributes are stored as sent, and may contain personal data. The privacy filter described in the [data classification](../../docs/security/data-classification.md) is not built.
- It does not limit rates or quotas, and does not delete or expire events.
- A retried event whose content differs from the first copy is not detected. The first copy wins.

## Development

```bash
pnpm --filter @codemugs/ingestion test   # database tests need CODEMUGS_TEST_DATABASE_URL
```
