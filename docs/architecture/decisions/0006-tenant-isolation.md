# 0006. Tenant isolation in the database

- **Status:** Proposed
- **Date:** 2026-11-07

## Context

Strict tenant isolation is release gate 1 and the most damaging thing to get wrong. Application code that remembers to add a tenant filter to every query will eventually forget once.

## Decision (proposed)

Defence in depth in the primary PostgreSQL database:

1. Every tenant-owned table has a non-null `organisation_id`. It is part of foreign keys and unique constraints so cross-tenant references are impossible by construction.
2. All access goes through a tenant-scoped data layer that requires a tenant context. There is no query path without one.
3. PostgreSQL row-level security enforces the same rule inside the database. The tenant is set per transaction, and the application's database role cannot bypass row-level security. Migrations run under a separate privileged role.
4. Cross-tenant access tests are mandatory from the first tenant-scoped table, and live in `tests/security`.

## Consequences

- Connection pooling must set the tenant per transaction and never leak it between requests.
- Workers and scheduled jobs need an explicit tenant context. "System" operations are a separate, audited path.
- Some query performance overhead is possible. Measure it rather than assume.
- Row-level security does not protect Redis, object storage or the analytical store. Each needs its own isolation rule, such as tenant-prefixed keys and paths with enforced access checks.

## Alternatives considered

- Schema per tenant, or database per tenant: stronger isolation, much higher operational cost. Likely relevant later for large or self-hosted customers.
- Application-level filtering only: simplest, and the easiest to get silently wrong.

## Open

This needs a short spike before it is accepted: confirm the approach works with the chosen data access library and connection pooler, and measure overhead on realistic queries.

## Revisit when

An enterprise customer requires physical isolation, or measurements show unacceptable overhead.
