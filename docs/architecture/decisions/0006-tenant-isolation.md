# 0006. Tenant isolation in the database

- **Status:** Accepted
- **Date:** 2026-11-07 (proposed), 2026-11-08 (accepted)

## Context

Strict tenant isolation is release gate 1 and the most damaging thing to get wrong. Application code that remembers to add a tenant filter to every query will eventually forget once.

## Decision

Defence in depth in the primary PostgreSQL database. This is implemented in `packages/storage` for the first two tables (`organisations`, `projects`); every later tenant-owned table must follow the same rules.

1. **Every tenant-owned table has a non-null `organisation_id`.** The tenant root, `organisations`, is keyed by its own `id`. A parent table also gets `UNIQUE (organisation_id, id)`, so a child table can reference `(organisation_id, parent_id)` and a row can never point at another tenant's parent. `projects` has that constraint ready; no child table uses it yet. Every unique constraint on a tenant-owned table includes `organisation_id`, otherwise a clash would reveal that another tenant holds a value.
2. **Application code reaches the database through `withTenant(pool, organisationId, work)`.** It checks the id is a UUID, opens a transaction, sets `app.organisation_id` with `set_config(..., true)` so the value lives only until that transaction ends, runs the work, and commits or rolls back. The client handed to the work refuses queries after the transaction ends. Using the pool directly does not bypass anything: with no tenant set, row-level security shows no rows.
3. **Row-level security enforces the rule inside PostgreSQL.** Every tenant table has `ENABLE` and `FORCE ROW LEVEL SECURITY` and a policy `TO codemugs_app` for both `USING` and `WITH CHECK`, comparing the row's organisation with `nullif(current_setting('app.organisation_id', true), '')::uuid`. A missing or empty setting gives NULL, which matches nothing: the policy fails closed. (`nullif` matters: on a pooled connection that has served a tenant before, the setting reads as an empty string, and casting that would raise an error instead of returning no rows.)
4. **The runtime role is restricted.** `codemugs_app` is not a superuser, has no `BYPASSRLS`, owns none of the tables (owners can switch row-level security off), has data-manipulation privileges only, and has no `TRUNCATE` (which ignores row-level security). Infrastructure creates the role. Migrations run as a separate privileged role and refuse to start if `codemugs_app` is missing.
5. **A new organisation is created by choosing its id, setting that id as the tenant, and inserting.** The `organisations` policy is `id = current tenant`, so the application cannot create or read any organisation other than the one it is acting as.
6. **Tests live next to the code.** `packages/storage` has cross-tenant tests that run against a real PostgreSQL, a schema guard that fails when any table lacks forced row-level security, a policy, a non-null `organisation_id` or least privilege (it also flags views that would bypass the policy), and a canary that proves those checks can fail. `tests/security` is for tests that cross layers (API, queues, caches) when those exist.

## Evidence so far

- On 2026-11-08, all storage tests passed against PostgreSQL 18.6 in the engineering session, with the database tests required rather than skipped.
- The same day, nine deliberate breakages were made one at a time (row-level security off, `FORCE` removed, an allow-everything policy on each table, writes unchecked, no `nullif`, `TRUNCATE` granted, a policy for every role, a session-wide instead of transaction-local setting). Each was caught by at least one test, and the files were restored afterwards. This was a manual run and is not automated.
- CI runs the same tests against PostgreSQL 17 and 18. That configuration is part of the change that accepted this decision; its result is recorded on that pull request.

## Consequences

- Connection pooling must set the tenant per transaction and never leak it between requests. `withTenant` does this, and tests cover reuse of a single connection, a failed transaction, and 60 concurrent requests over two connections.
- Workers and scheduled jobs need an explicit tenant context. "System" operations are a separate, audited path that does not exist yet.
- **Row-level security does not defend against code that chooses the wrong tenant.** The tenant is a session setting, so code that can run its own SQL as `codemugs_app` can set a different one. A test pins this down so nobody assumes more. The protection is against forgotten filters and leaks between requests. That is why the tenant must come only from the authenticated credential (invariant 1).
- Superusers and roles with `BYPASSRLS` ignore the policies. The migration role and any administration tooling must never be used by the application.
- PostgreSQL's own foreign-key checks bypass row-level security. The insert path was tested and gives the same error whether or not the other tenant's row exists. New paths that touch other tenants' rows need the same test.
- Views run with their owner's rights unless they are `security_invoker`, and materialised views cannot have row-level security. The schema guard rejects both in the `public` schema.
- Row-level security does not protect Redis, object storage or the analytical store. Each needs its own isolation rule, such as tenant-prefixed keys and paths with enforced access checks.

## Not yet done

These keep release gate 1 open. They do not change the decision.

- Overhead has not been measured on realistic queries.
- Behaviour behind an external pooler such as PgBouncer in transaction mode has not been tested. A transaction-local setting is designed to work there, but that is not evidence.
- Isolation is tested in the storage layer only. API, queue and cache layers do not exist yet.

## Alternatives considered

- Schema per tenant, or database per tenant: stronger isolation, much higher operational cost. Likely relevant later for large or self-hosted customers.
- Application-level filtering only: simplest, and the easiest to get silently wrong.

## Revisit when

An enterprise customer requires physical isolation, or measurements show unacceptable overhead.
