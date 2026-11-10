# @codemugs/ingestion

Validates events and records them durably. A library for now, used by the [API](../api/README.md) for `POST /v1/events`. A separate gateway process (the OpenTelemetry endpoint, its own scaling) is planned and can use the same code.

**Status:** Phase 1 · Foundation (started). Validation, storage and the first processing exist: a stored batch enqueues a [job](../../packages/jobs/README.md) and a handler turns it into hourly counts. A worker process that runs the handler, redaction, rate limits and quotas do not. Decisions: [ADR 0011](../../docs/architecture/decisions/0011-event-ingestion.md), [ADR 0013](../../docs/architecture/decisions/0013-event-processing.md).

## Interface

- `recordEvents(pool, scope, body)`: validates a request body of events and stores them. `scope` is `{ organisationId, projectId, apiKeyId }` and must come from the authenticated credential. Returns `{ ok: true, result }` with one result per event, in order, or `{ ok: false, error }` when the body as a whole is unusable (`body_not_an_object`, `events_missing`, `events_empty`, `too_many_events`). It **throws** when the database fails, so a caller answers `5xx` and the client retries. In the same transaction it enqueues one `events.aggregate` job for the batch, but only if at least one event was newly stored, so a retry of a stored batch makes no second job. If the job cannot be enqueued nothing is stored.
- `validateEvent(item, now)` and `checkBatchShape(body)`: the validation on its own, with no database.
- `aggregateEventsHandler` and `EVENTS_AGGREGATE_KIND`: the job handler to register with a worker, `{ [EVENTS_AGGREGATE_KIND]: aggregateEventsHandler }`. `aggregateEvents(client, batchId)` is the same work for a transaction you already hold. It writes the number of events per project and UTC hour, counted by when they happened, for every hour the batch touches. It counts the events themselves and replaces the stored number, so it gives the same rows however many times and in whatever order it runs.

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
- **Processing is idempotent and recoverable** at the level of the queue: the same batch processed repeatedly, a worker that died after taking the job, an attempt that failed after writing, and a replay all end with the same counts. See [ADR 0013](../../docs/architecture/decisions/0013-event-processing.md) for what is and is not covered.

## What it does not do

- It does not redact. Attributes are stored as sent, and may contain personal data. The privacy filter described in the [data classification](../../docs/security/data-classification.md) is not built.
- It does not limit rates or quotas, and does not delete or expire events. Counts are recomputed from the events, so deleting events will need a decision about the counts first.
- Nothing runs the handler outside tests yet: there is no worker process.
- A retried event whose content differs from the first copy is not detected. The first copy wins.

## Development

```bash
pnpm --filter @codemugs/ingestion test   # database tests need CODEMUGS_TEST_DATABASE_URL
```
