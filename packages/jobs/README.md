# @codemugs/jobs

A durable job queue in PostgreSQL, and a worker that runs the jobs. Background work that survives a crash, can be run again, and never leaves the tenant that owns it.

**Status:** Phase 1 · Foundation (started). The library and its tests exist. The process that runs it is [`@codemugs/worker`](../../apps/worker/README.md) ([ADR 0014](../../docs/architecture/decisions/0014-worker-process.md)). Ingestion enqueues a job for every stored batch and one handler exists, for hourly counts ([ADR 0013](../../docs/architecture/decisions/0013-event-processing.md), in [`@codemugs/ingestion`](../../apps/ingestion/README.md)). Decision: [ADR 0012](../../docs/architecture/decisions/0012-jobs-and-cross-tenant-claiming.md). The table is in [`@codemugs/storage`](../storage/README.md).

## What is here

- `enqueueJob(client, { kind, subjectId?, maxAttempts? })`: adds a job for the organisation the transaction acts for. Call it in the same transaction that wrote the work. Enqueueing the same `(kind, subjectId)` again returns `{ status: "exists" }`.
- `requeueJob(client, { kind, subjectId })`: replay. Puts a succeeded or dead job back with fresh attempts. Refuses (returns `false`) a job that is waiting or running.
- `runWorker({ dispatcher, app, handlers, signal, ... })`: takes jobs of the kinds it has handlers for, runs each in a transaction restricted to the job's tenant, and marks it succeeded in that same transaction. Retries with backoff, gives up after `max_attempts`, recovers jobs whose worker died, and stops gracefully when the signal aborts.
- `JobFailure(code, { retryable? })`: throw it from a handler to fail with a short stable code.
- `claimJobs`, `completeJob`, `failJob`: the steps `runWorker` is made of, for tests and for anything that needs them separately.

```ts
const controller = new AbortController();
await runWorker({
  dispatcher: createPool({ connectionString: dispatcherDatabaseUrl }), // codemugs_dispatcher
  app: createPool({ connectionString: applicationDatabaseUrl, maxConnections: 8 }), // codemugs_app
  concurrency: 4,
  signal: controller.signal,
  handlers: {
    "events.aggregate": async (job, { client, signal }) => {
      // Read the tenant's data and write the result so that running again gives the same rows.
    },
  },
  onEvent: (event) => log.info(event), // ids, kind, attempt and a short code. Never a message.
});
```

## Rules for handlers

- **A handler can run more than once for the same subject.** After a failure, after a crash, or after replay. Compute the result from the tenant's data and write it idempotently (an upsert of a recomputed value). Do not apply a delta ("add 3 to the count").
- **Writes through `context.client` are exactly once.** They commit together with the job's completion, or are rolled back. Effects outside the database (an HTTP call, a model call) cannot be rolled back and are at least once.
- **Never put customer data in a failure code or in a job.** A job holds its kind and an opaque id that points at tenant data (a row, or a batch of rows), nothing else, and a failure is stored as a short code. A thrown error's message is dropped on purpose.
- **Stop when `context.signal` aborts.** It fires when the lease runs out. After that another worker may take the job, and this run's transaction is rolled back if one does. Choose a lease longer than your longest handler.

## Rules for the worker's database

- The **dispatcher** pool uses the `codemugs_dispatcher` role, which only worker processes hold, never the API. It can see the `jobs` table across tenants and nothing else.
- The **app** pool uses `codemugs_app` and needs at least `concurrency` connections: each job in progress holds one. `runWorker` refuses to start otherwise.
- Time comes from the database's clock. A worker with a wrong clock cannot take or hold anyone's job.

## Not here yet

Per-tenant fairness and quotas, priorities, delayed jobs, lease extension (heartbeats), wake-ups instead of polling, a history of attempts, alerting on dead jobs, retention of finished jobs, and any measurement of throughput. The list and the reasons are in ADR 0012.

## Running the tests

The unit tests need nothing. The database tests need the same setup as `@codemugs/storage` (see its README) and are skipped when `CODEMUGS_TEST_DATABASE_URL` is not set.

```bash
pnpm build   # the tests use the built storage package and its test helpers
pnpm --filter @codemugs/jobs test
```
