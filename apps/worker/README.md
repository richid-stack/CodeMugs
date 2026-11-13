# @codemugs/worker

The process that runs queued jobs. It takes due jobs from the queue ([`@codemugs/jobs`](../../packages/jobs/README.md)), runs the handler for each kind in the tenant's own transaction, and records the result.

**Status:** Phase 1 · Foundation (started). It runs one kind of job, `events.aggregate`: the hourly counts of [ADR 0013](../../docs/architecture/decisions/0013-event-processing.md). There is no container image, no health endpoint and no deployment yet. Decision: [ADR 0014](../../docs/architecture/decisions/0014-worker-process.md).

## What it does

1. Reads its configuration. Invalid configuration fails at startup and names the variables at fault, never their values.
2. Connects as two different database roles (`DATABASE_URL`, the application role, and `DISPATCHER_DATABASE_URL`, the dispatcher role) and checks them before it takes any job: each connection must be the role it should be, that role must have none of the powers the role contract forbids and belong to no other role, and the database must have what the handlers use. A failed check ends the process with exit code 1 and a log line that names the variable and a short code.
3. Takes jobs and runs them, up to `WORKER_CONCURRENCY` at a time, until it is told to stop.
4. On `SIGTERM` or `SIGINT` it takes no new job, waits for the jobs in progress, closes its connections and exits with code 0. A signal that arrives while it is still connecting is remembered and acted on as soon as it has started, so it ends the same way. A job still running after `SHUTDOWN_TIMEOUT_MS` is abandoned and the process exits with code 1. An abandoned job leaves no trace in the data, because its transaction ends with the connection, and another worker takes the job when its lease runs out.

## Logging

One JSON object per line on standard output, with `level`, `time` and `msg`. A line about a job carries `jobId`, `organisationId`, `kind` and `attempt`, and a failure adds a short `code`. Nothing else is logged about a job: not its error message, not the data it worked on. A fatal error is logged by its type, its SQLSTATE if it has one, and the stack frames, without the message, because a database error can repeat the value it rejected (repository invariant 3). The configuration, including both connection strings, is never logged.

| Level   | What                                                                                          |
| ------- | --------------------------------------------------------------------------------------------- |
| `debug` | A job was taken                                                                               |
| `info`  | The worker is starting and has started, a job succeeded, shutdown was requested and completed |
| `warn`  | A job failed and will be tried again, or its lease was lost to another worker                 |
| `error` | A job failed for good, a database connection failed, the worker could not record a result     |
| `fatal` | The worker could not start, or the process is about to exit because of an error               |

## Configuration

| Variable                  | Default       | Notes                                                                                                                                            |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`            | required      | `postgres://` or `postgresql://`, for the application role `codemugs_app`. Handlers run in tenant transactions on this one                       |
| `DISPATCHER_DATABASE_URL` | required      | For the dispatcher role `codemugs_dispatcher`, which finds due jobs in any tenant and can do nothing else. A different login from `DATABASE_URL` |
| `WORKER_CONCURRENCY`      | `4`           | Jobs at the same time, 1 to 100. The application pool has this many connections                                                                  |
| `WORKER_POLL_INTERVAL_MS` | `1000`        | How long to wait before looking again when there was no job. At least 10                                                                         |
| `WORKER_LEASE_SECONDS`    | `60`          | How long a worker holds a job before another may take it, 1 to 86400                                                                             |
| `SHUTDOWN_TIMEOUT_MS`     | `30000`       | How long jobs in progress get to finish after a stop request                                                                                     |
| `LOG_LEVEL`               | `info`        | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`                                                                                   |
| `NODE_ENV`                | `development` | `development`, `test` or `production`                                                                                                            |

## Running it

```bash
pnpm infra:up                 # PostgreSQL with the two roles, locally (needs Docker)
pnpm dev:worker               # runs with reload; reads ../../.env if present
pnpm --filter @codemugs/worker build && pnpm --filter @codemugs/worker start
```

It needs a database that has been migrated, and it checks that at startup. Apply the migrations with [`pnpm db:migrate`](../migrate/README.md) first.

## Tests

```bash
pnpm build                          # the process tests run the built program
pnpm --filter @codemugs/worker test
```

The unit tests need nothing. The database tests need the same setup as `@codemugs/storage` (see its README) and are skipped when `CODEMUGS_TEST_DATABASE_URL` is not set. They cover the startup checks (each forbidden role power, a database that is not migrated, a role without the grants, an unreachable database), starting and stopping, the log, and the built program as a separate process: processing, `SIGTERM` and `SIGINT` (including one that arrives while it is still starting), finishing the job in progress before it exits, giving up on one that will not finish, and the ways it refuses to start.

## Not done

- No container image and no deployment. Hosting is undecided.
- No health or readiness endpoint, and no heartbeat. An orchestrator can tell the process is gone, not that it is stuck.
- No metrics, and no alert on dead jobs (release gate 13).
- No retry of the first connection: a database that is not up yet fails the start, and the orchestrator restarts the process.
- The path of an uncaught exception or unhandled rejection (log and exit 1) has no test.
- Jobs of a kind this process has no handler for stay queued. Nothing reports them.
