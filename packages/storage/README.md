# @codemugs/storage

Tenant-scoped access to the primary PostgreSQL database, and its migrations.

**Status:** Phase 1 · Foundation (started). The database part exists: migrations, a connection pool, tenant-scoped transactions and the first four tables. Object storage and the cache do not exist yet.

Decisions: [ADR 0006](../../docs/architecture/decisions/0006-tenant-isolation.md) (tenant isolation) and [ADR 0009](../../docs/architecture/decisions/0009-data-access-and-migrations.md) (data access, versions, migrations).

## What is here

- `createPool(options)`: a `pg` pool for the **application role** with a statement timeout and an idle-in-transaction timeout by default.
- `withTenant(pool, organisationId, work)`: the way application code reaches the database. It runs `work` in a transaction in which `app.organisation_id` is set, so row-level security shows only that organisation's rows. A pool used without it sees no rows, not all rows.
- `runMigrations(connectionString)`: applies the numbered SQL files in `migrations/`. Run it as the **privileged role**, over a direct connection.
- `loadMigrations()`: reads and validates the files without touching a database.
- `postgresErrorCode(error)`: the SQLSTATE of a database error, so callers map specific failures without matching message text.
- `@codemugs/storage/testing`: the test harness and schema guard, for **test files only** (a database per test file, the restricted role, and a check of every table against the tenancy rules). Other packages with database tests use it.
- Tables so far: `organisations`, `projects`, `api_keys` and `audit_log`. The last two are used by [`@codemugs/auth`](../auth/README.md) ([ADR 0010](../../docs/architecture/decisions/0010-api-keys-and-audit-log.md)).

```ts
const pool = createPool({ connectionString: applicationDatabaseUrl });
const projects = await withTenant(pool, organisationId, async (db) => {
  const result = await db.query<{ id: string; name: string }>("SELECT id, name FROM projects");
  return result.rows;
});
```

`organisationId` must come from the authenticated credential, never from a request body, query string or event payload (repository invariant 1).

## Adding a table

1. Add a new numbered file to `migrations/`. Do not edit an applied one: the runner rejects a changed file. Do not put `BEGIN` or `COMMIT` in it.
2. Give a tenant-owned table a non-null `organisation_id`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, a policy `TO codemugs_app` that uses `nullif(current_setting('app.organisation_id', true), '')::uuid` for both `USING` and `WITH CHECK`, and grants that exclude `TRUNCATE`. Include `organisation_id` in every unique constraint, and in both sides of every foreign key to another tenant table (reference `(organisation_id, id)`). An audit-style table the application must not change grants `SELECT` and `INSERT` only.
3. Run the tests. The schema guard fails if any of that is missing, and the cross-tenant tests are where you add the new table's cases.

## Running the tests

The unit tests need nothing. The database tests need a PostgreSQL server you can use as a superuser, and are skipped when none is configured:

```bash
pnpm infra:up   # local Postgres; the dev superuser is "codemugs" (see infrastructure/docker/compose.dev.yml)
export CODEMUGS_TEST_DATABASE_URL=postgres://codemugs:codemugs_dev_only@127.0.0.1:5432/codemugs
pnpm --filter @codemugs/storage test
```

Each test file creates its own database and the restricted `codemugs_app` role, and drops the database afterwards. Set `REQUIRE_DATABASE_TESTS=true` (CI does) to make a missing database a failure instead of a skip.

## Limits

Row-level security stops forgotten filters and leaks between requests. It does not stop code that can run its own SQL as the application role from choosing another tenant; a test documents this. Query overhead and behaviour behind an external pooler have not been measured. See ADR 0006.
