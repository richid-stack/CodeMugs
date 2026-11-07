# 0005. Modular monolith and PostgreSQL-first storage

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

The architecture lists many powerful components: ClickHouse, NATS JetStream, Temporal, a dedicated graph database, Kubernetes. Adopting all of them before proving the core idea would add operational burden without evidence of need.

## Decision

- A modular monolith with separate worker processes and isolated execution infrastructure, in one monorepo. Module boundaries are explicit in the directory structure. Services are split out when scaling or security boundaries demand it.
- PostgreSQL is the primary store for relational records, the Application Intelligence Graph (relational tables with graph-oriented relationships), audit metadata, and initially durable jobs and events. pgvector provides semantic retrieval. Redis handles caching, rate limits and short-lived coordination.
- ClickHouse, NATS JetStream, a dedicated graph database and Kubernetes are introduced only when measured needs justify them.

## Consequences

- Raw telemetry volume will eventually exceed what Postgres should hold. Retention, partitioning and deletion policies are designed from the start so that moving telemetry to ClickHouse later is a migration, not a rewrite.
- Boundaries between modules must be real even though they share a deployable, so they can be separated later.

## Open question

Temporal gives durable workflows that can wait for human approval, which investigations and engineering workflows need. PostgreSQL-backed jobs may be enough for the earliest workflows. A spike during Phase 1 should decide when Temporal is introduced. Record the outcome as a new ADR.

## Revisit when

Measured load, an isolation requirement, or workflow complexity makes any of the deferred components necessary.
