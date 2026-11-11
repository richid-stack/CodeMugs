# @codemugs/migrate

The command that applies the database migrations. It runs once, reports what it did, and exits. It is meant to be a step of a deployment, before the API and the worker start, and it is the only place outside the tests that calls `runMigrations` ([`@codemugs/storage`](../../packages/storage/README.md)).

**Status:** Phase 1 · Foundation (started). It works against a real PostgreSQL and is tested as a separate process. There is no container image, no deployment pipeline and no way yet to list pending migrations without applying them. Decision: [ADR 0015](../../docs/architecture/decisions/0015-migration-command.md).

## What it does

1. Reads its configuration. Invalid configuration ends the run with exit code 1 and names the variables at fault, never their values.
2. Checks the migration files themselves (numbering, names) before it connects.
3. Connects as the migration role and, before it changes anything, checks two things: that the login is **not** the application role or the dispatcher role, and that both of those roles exist. A migration run as a runtime role could leave that role owning the tables, and an owner can switch row-level security off ([ADR 0006](../../docs/architecture/decisions/0006-tenant-isolation.md)), so it is refused rather than tried.
4. Applies the pending migrations in order, each in its own transaction, and logs each one when it has committed. A second run, or a run that has nothing to do, logs `database is up to date` and exits with code 0. Two runs at the same time are serialised by the lock in the runner ([ADR 0009](../../docs/architecture/decisions/0009-data-access-and-migrations.md)), and each migration is applied once.
5. Exits with code 0 if every migration is applied, and with code 1 for anything else.

It does not create the roles. Infrastructure does ([`infrastructure/database`](../../infrastructure/database/README.md)).

## Configuration

| Variable                 | Default       | Notes                                                                                                                                                                                               |
| ------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIGRATION_DATABASE_URL` | required      | `postgres://` or `postgresql://`, for the **migration role**: it owns the tables and may create them. A direct connection, not a transaction-mode pooler. Held in `Secret`, never logged or printed |
| `MIGRATION_TIMEOUT_MS`   | `600000`      | The longest the whole run may take, including waiting for another run's lock. 1000 to 3600000. Set it above your slowest migration                                                                  |
| `LOG_LEVEL`              | `info`        | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`                                                                                                                                      |
| `NODE_ENV`               | `development` | `development`, `test` or `production`                                                                                                                                                               |

It reads `MIGRATION_DATABASE_URL` and nothing else for the connection. It does not fall back to `DATABASE_URL`, so a pipeline that has the application's variables cannot migrate with them by accident.

## Running it

```bash
pnpm infra:up                  # PostgreSQL with the two roles, locally (needs Docker)
pnpm db:migrate                # runs from source; reads ../../.env if present
pnpm --filter @codemugs/migrate build && pnpm --filter @codemugs/migrate start
```

## What it prints

One JSON object per line on standard output, with `level`, `time` and `msg` (the same log as the worker, from [`@codemugs/logging`](../../packages/logging/README.md)). A configuration error is the one exception: it is plain text on standard error, because the log is not set up yet.

| `msg`                         | Fields                                         | When                                                          |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| `migration applied`           | `version`, `name`                              | Each migration, after it has committed                        |
| `migrations applied`          | `applied`, `total`                             | The run finished and applied something                        |
| `database is up to date`      | `applied` (0), `total`                         | The run finished and there was nothing to apply               |
| a sentence naming the problem | `code`, and `version`, `cause` when they apply | The run failed (level `error`, or `fatal` for the time limit) |

The failure codes:

| `code`                 | Meaning                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `migrations_invalid`   | The files do not follow the rules (a gap in the numbering, a bad name). Nothing was connected to                                          |
| `database_unreachable` | The first connection or query failed. The message has a SQLSTATE or a network error code, not an address                                  |
| `wrong_role`           | The login is the application role or the dispatcher role                                                                                  |
| `roles_missing`        | One or both runtime roles do not exist. Only the missing ones are named                                                                   |
| `history_mismatch`     | A migration file changed after it was applied, the history is out of order, or the database is ahead of this build. The version is given  |
| `migration_failed`     | A migration's SQL failed. It was rolled back and the earlier ones stay. `version` and `cause` (a SQLSTATE) are given                      |
| `database_error`       | Anything else that went wrong while running, with a SQLSTATE or network code (for example a login that may not create tables: `db_42501`) |
| `timeout`              | `MIGRATION_TIMEOUT_MS` passed                                                                                                             |
| `interrupted`          | `SIGTERM` or `SIGINT`                                                                                                                     |

It never prints the connection string, a host or port, the SQL, a migration file's contents, or what the database said about a failure. A failed migration is reported by its version and the SQLSTATE of the error, because a data error can repeat the value it rejected (repository invariant 3).

## If it is cut short

A run that reaches its time limit, or is told to stop, ends the process with exit code 1. That drops the database connection, so the migration in progress does not commit, and the ones already committed stay applied. The next run takes up from there. The abandoned statement itself may keep running on the server until it ends, because PostgreSQL does not cancel a running statement when its client goes away; it cannot commit, and the lock the runner holds is released only when that session ends. This last point comes from how PostgreSQL works and is not tested: the tests cut a run short while it waits for the lock, not in the middle of a statement.

## Tests

```bash
pnpm build                          # the process tests run the built program
pnpm --filter @codemugs/migrate test
```

The database tests need the same setup as `@codemugs/storage` (see its README) and are skipped when `CODEMUGS_TEST_DATABASE_URL` is not set; CI requires them. They cover each failure above against a real PostgreSQL (including a failing migration, a data error that repeats a secret, a changed file, a database ahead of the build, and a login without the right to create tables), the schema that results, two runs at once, and the built program as a separate process: configuration errors, a successful run, a second run, the wrong role, an unreachable database, the time limit and both signals while another run holds the lock.

## Not done

- No way to list the pending migrations, or to check a database without changing it (a `--check` mode).
- No container image and no deployment pipeline. Hosting is undecided.
- A run cut short in the middle of a statement is not tested (see above).
- The path of an uncaught exception or unhandled rejection (print the failure's type and exit 1) has no test.
- It does not check that the migration role is the right one beyond refusing the two runtime roles. A role that may not create tables fails at the first migration with `database_error` and `db_42501`, and a superuser would be accepted.
- Migrations that cannot run inside a transaction (such as `CREATE INDEX CONCURRENTLY`) are not supported, as in [ADR 0009](../../docs/architecture/decisions/0009-data-access-and-migrations.md).
