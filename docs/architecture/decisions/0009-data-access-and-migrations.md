# 0009. Data access, PostgreSQL versions and migrations

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

[ADR 0005](0005-modular-monolith-and-postgres-first-storage.md) chose PostgreSQL as the primary store. [ADR 0006](0006-tenant-isolation.md) needs every query to run inside a transaction that carries the tenant, and needs control over database roles. We need to choose the PostgreSQL versions we support, how code talks to the database, and how the schema changes.

## Decision

1. **Support PostgreSQL 17 and 18.** Develop on 18. CI runs the database tests on both. The local development compose file stays on 17 (with pgvector) until a PostgreSQL 18 image with pgvector is confirmed; 17 is the floor.
2. **Use `pg` (node-postgres) with hand-written SQL.** No ORM and no query builder. The tenant transaction, the role boundary and the row-level security policies are the core of the design, and plain SQL keeps them visible and reviewable. Input is validated with zod at the edge (`withTenant` validates the tenant id), and values are always bound parameters.
3. **Numbered SQL migrations in `packages/storage/migrations`, applied by a small in-house runner.** Files are named `NNNN_description.sql`, numbered 0001 upward with no gaps or duplicates. The runner takes a PostgreSQL advisory lock so concurrent starts cannot collide, applies each pending file in its own transaction, records a SHA-256 checksum, and refuses to continue if an applied file has changed, if the history is out of order, or if the database is ahead of the build. The checksum error never prints the SQL.
4. **Migrations are forward-only.** There are no down migrations: a mistake is fixed by a new migration. A migration file must not contain its own `BEGIN` or `COMMIT`, because the runner supplies the transaction. This is a review convention, not checked by the runner.
5. **Roles are created by infrastructure, not by migrations.** Migrations run over a direct connection as a privileged role (the advisory lock is per session, so not through a transaction-mode pooler). The application connects as `codemugs_app` and never as the migration role.
6. **The pool has timeouts by default:** 30 seconds for a statement and for a session idle inside a transaction, so a stuck request cannot hold a connection forever.

## Consequences

- We write and review SQL by hand. That is more typing than an ORM and gives no automatic type safety for query results; row types are declared at the call site.
- We own about 130 lines of migration code, with tests, instead of depending on a migration tool.
- Two PostgreSQL majors in CI doubles the database test time for the storage package.
- Staying on `pg` keeps a later move to a different access layer cheap, because the SQL is already written and tested.

## Alternatives considered

- ORMs and query builders (Prisma, Drizzle, Kysely) and off-the-shelf migration tools. They were not compared in a head-to-head spike. The deciding reason is control of the transaction and role boundary, not a measured shortcoming. Revisit if hand-written SQL becomes a burden as the schema grows.
- PostgreSQL 18 only: simpler, but it would exclude self-hosted customers on 17.

## Not yet verified

- Behaviour behind PgBouncer or another pooler.
- A PostgreSQL 18 image with pgvector for local development.

## Revisit when

The schema or query volume makes hand-written SQL a burden, a customer needs a version outside 17 and 18, or a pooler is introduced.
