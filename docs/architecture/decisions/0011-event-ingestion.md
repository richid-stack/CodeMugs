# 0011. Event ingestion: the contract and the storage

- **Status:** Accepted
- **Date:** 2026-11-09

## Context

Step 4 of the [build plan](../../engineering/roadmap.md) is event ingestion. Release gates 3 and 4 ask for retries and duplicate delivery to be safe. SDKs retry, buffer and resend, so the endpoint has to behave well when the same batch arrives twice, when two copies arrive at once, and when one event in a batch is bad. This record covers the first half: accepting events and storing them durably. Processing them (a job queue, workers, crash recovery, replay) is the second half and gets its own record.

## Decision

1. **Every event gets its own result.** `POST /v1/events` takes 1 to 500 events. The response is `202` when the batch was understood, and its body says what happened to each event, in order: `accepted`, `duplicate` or `rejected` with a stable reason. A client drops rejected events (retrying cannot help) and retries on `5xx` only. An all-or-nothing batch was rejected because one event that can never be accepted would then block its whole batch for ever.
2. **The idempotency key is the project plus the client's event id.** The primary key is `(organisation_id, project_id, event_id)`. A repeated event is acknowledged as `duplicate`, and the **first copy wins**: a retry that carries different content is not detected. Ids are matched ignoring letter case, because PostgreSQL stores a UUID in lower case. Detecting a changed retry would need a second query and a notion of equality, and the client cannot do anything useful with the answer.
3. **Acknowledged means committed.** An event is reported `accepted` only after its transaction commits. A failure of the database is thrown, never reported as a rejection, so the client retries instead of dropping events. The whole batch is one statement, so nothing from a failed batch is stored.
4. **No input can make the database fail.** A request that fails in the database is retried by the client, so one event that can never be stored would be retried for ever. Everything that is valid to the schema but unstorable is therefore rejected per event before it reaches the database: a NUL character or a lone surrogate in any string or key (PostgreSQL refuses both), a number that is not finite, attributes nested more than 20 levels, and an `occurredAt` before 2000 (the schema allows year 0000, which PostgreSQL refuses) or more than a day ahead of the server. Validation reports only a stable reason and the top-level field, never a value.
5. **Rows are inserted in event id order.** Two clients retrying overlapping batches would otherwise insert the same keys in opposite orders and deadlock. A test that does this fails every time without the ordering.
6. **Events are immutable.** The application role can insert and read them and nothing else. The schema guard treats `events` as append-only, like `audit_log`. A path for deleting events (retention, offboarding) does not exist yet and will be a deliberate, audited one.
7. **Not partitioned, two secondary indexes.** PostgreSQL needs the partition key in every unique constraint, which would weaken the idempotency key, since a retry arrives at a different time. The two indexes (by project and event time, by receive time) are built now because a later index cannot be built without blocking writes: migrations run in a transaction, which rules out `CREATE INDEX CONCURRENTLY`. Both are for readers that do not exist yet and are not measured.
8. **Customer data stays out of logs.** Event content is never logged. Database errors are logged as their kind, SQLSTATE, table, column and constraint, without `detail`, without `where` (which quotes the JSON that failed) and, for data exceptions, without the message (which repeats the value). The first line of a stack holds the message, so a database error is logged with its frames only.
9. **JSON only, with stable error codes.** Anything but `application/json` gets `415 unsupported_media_type`, bad JSON gets `400 invalid_json` without repeating the body, and an oversized body gets `413 payload_too_large`. Framework error codes are mapped to these so the framework can change without changing the API. Authentication runs first, so an unauthenticated caller never makes the server read a body.
10. **The code is the `apps/ingestion` module.** It is a library for now, used by the API. A separate gateway process (the OpenTelemetry endpoint, its own scaling) can use it later without a rewrite.

## Not decided, or not done

- **No rate limits and no per-tenant quotas** (open question 10). One key can write as fast as the database allows, up to 500 events and 1 MiB a request. This and the missing authentication limit mean the API must not be exposed to the internet yet.
- **No redaction.** The data classification says telemetry is redacted in SDKs and again at the gateway, because it can hold personal data by accident. The gateway step does not exist, so attributes are stored exactly as sent. Real customer SDK traffic should not be pointed at this until it does.
- **No retention and no deletion** (open question 5, release gate 15). The table only grows.
- **Nothing reads events back and nothing processes them.** There is no query endpoint and ingestion does not enqueue anything yet. The queue and workers exist as a library ([ADR 0012](0012-jobs-and-cross-tenant-claiming.md)); connecting them is the next change.
- **The timestamp window is a product choice.** An SDK on a device with a wrong clock loses events with `occurred_at_out_of_range`. It can be loosened if that proves wrong.
- **Stored attributes are what JavaScript makes of the JSON.** Numbers are doubles, an attribute named `__proto__` is dropped, and timestamps keep millisecond precision.
- **Throughput is unmeasured.** There is no load test (release gate 18).

## Evidence so far

- On 2026-11-09, with database tests required, `pnpm verify` passed against PostgreSQL 18.6: 81 storage, 74 ingestion and 99 API tests among 356 in all, plus the smoke test, the link check and the dependency audit.
- Twenty-five deliberate breakages were made one at a time: each timestamp, character and nesting rule removed, a client event id echoed unchecked, event id case ignored, duplicates inside a batch undetected, `ON CONFLICT` removed, the insertion order removed, `202` changed to `200`, request fields allowed to override the credential's tenant, the default error serializer restored, the stack and data-exception message left in the log, `text/plain` parsed again, framework codes shown to clients, update granted on `events`, row-level security not forced, either foreign key removed, the object check on `attributes` removed, and the key made unique across the organisation. Each is now caught by at least one test, and the files were restored afterwards. The first run left one alive (event id case, when the upper-case form comes first), which showed a test was weaker than it looked; two tests were added. This was a manual run and is not automated.
- Testing found two things. Without the insertion order, overlapping retries in opposite orders deadlock (the test failed 3 times out of 3 without it). And with forced row-level security PostgreSQL leaves the failing row out of a constraint error, so the leak that was feared there does not happen; the real one is a data exception, whose context quotes the JSON. That case is tested against a real PostgreSQL error.
- CI runs the same tests on PostgreSQL 17 and 18. Its result is recorded on the pull request that accepted this decision.
