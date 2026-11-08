# Data model overview (draft)

> **Draft.** Only the tenancy foundation exists as a schema: `organisations` and `projects`, in [`packages/storage/migrations`](../../packages/storage/migrations). Everything else below is planned. This establishes the groupings and the rules every table must follow. Field-level design happens table by table.

## Rules for every table

- **Tenant-owned rows carry `organisation_id`**, non-null, and it participates in foreign keys and unique constraints so a row can never point at another tenant's data. Every table also has forced row-level security. See [ADR 0006](../architecture/decisions/0006-tenant-isolation.md).
- **Tenant identity comes from the authenticated credential**, never from a payload.
- **Credentials are never stored in the application database in usable form.** The database holds references to secrets managed by a KMS or vault. API keys are stored hashed.
- **Audit records are append-only.**
- **Every store supports deletion and retention** from the first migration. See [data classification](../security/data-classification.md).
- **High-volume telemetry does not live in the primary database for long.** See [ADR 0005](../architecture/decisions/0005-modular-monolith-and-postgres-first-storage.md).

## Entity groups

| Group                | Entities                                                                        | Notes                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Identity and tenancy | organisation, user, membership, role, service account, API key                  | Region is an attribute of the organisation from the start.                                               |
| Integrations         | integration, credential reference, sync state and checkpoint                    | One record per connected system. Checkpoints support incremental sync.                                   |
| Application model    | application, environment, service, deployment, graph entity, graph relationship | The Application Intelligence Graph, relational first.                                                    |
| Runtime              | ingestion batch record, aggregate, incident                                     | Raw events go to the analytical store when volume justifies it. Postgres holds aggregates and incidents. |
| Intelligence         | finding, signal group, hypothesis, diagnosis, evidence item                     | Evidence items back the evidence ledger.                                                                 |
| Engineering          | task, run, approval, pull request link                                          | A run records which runtime, sandbox and budget were used.                                               |
| Governance           | policy, autonomy setting, audit entry                                           | Policies are evaluated by the policy engine, never by agents.                                            |
| Memory               | memory entry                                                                    | See below.                                                                                               |

## Memory entry fields

Every memory entry carries: source, timestamp, project association, confidence, evidence, version, expiry or review policy, provenance, and links to related incidents and decisions. Categories are project, system, incident, engineering, product and outcome memory. Memory is supporting evidence and is never treated as unquestionable truth.

## Graph entities and relationships

Entities named in the architecture: application, service, endpoint, database, table, function, dependency, deployment, incident, user feedback, code change.

Relationships: calls, depends on, writes to, reads from, implements, introduced by, affected by, correlates with, owned by.

Represented as relational tables with graph-oriented relationships first. A dedicated graph store is considered only when measured query needs justify it.
