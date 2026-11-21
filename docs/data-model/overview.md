# Data model overview (draft)

> **Draft.** Only the tenancy, identity, event and repository-graph foundation exists as a schema: `organisations`, `projects`, `api_keys`, `audit_log`, `events`, `jobs`, `event_aggregates`, `analysis_runs`, `graph_nodes`, `graph_edges`, `github_installations`, `repository_connections` and `analysis_requests`, in [`packages/storage/migrations`](../../packages/storage/migrations). Everything else below is planned. This establishes the groupings and the rules every table must follow. Field-level design happens table by table.

## Rules for every table

- **Tenant-owned rows carry `organisation_id`**, non-null, and it participates in foreign keys and unique constraints so a row can never point at another tenant's data. Every table also has forced row-level security. See [ADR 0006](../architecture/decisions/0006-tenant-isolation.md).
- **Tenant identity comes from the authenticated credential**, never from a payload.
- **Credentials are never stored in the application database in usable form.** The database holds references to secrets managed by a KMS or vault. API keys are stored hashed: `api_keys` holds the SHA-256 of a key's secret and never the key ([ADR 0010](../architecture/decisions/0010-api-keys-and-audit-log.md)).
- **Audit records are append-only.** `audit_log` allows the application to insert and read only, and triggers stop updates, deletes and truncation even for privileged roles. A database administrator can still disable the triggers.
- **Every store supports deletion and retention** from the first migration. See [data classification](../security/data-classification.md). `events` has indexes for retention by age but no deletion path yet: the application cannot delete events, and a deliberate, audited path is still to be built (release gate 15).
- **Events are immutable.** `events` allows the application to insert and read only. The primary key `(organisation_id, project_id, event_id)` is the idempotency key ([ADR 0011](../architecture/decisions/0011-event-ingestion.md)).
- **Jobs are pointers, never data.** `jobs` holds a job's kind, the id of the tenant row it is about and its progress, and has no payload column, so a worker role that can see every tenant's jobs learns nothing it can misuse. That role (`codemugs_dispatcher`) can read and advance `jobs` and cannot touch any other table ([ADR 0012](../architecture/decisions/0012-jobs-and-cross-tenant-claiming.md)). Jobs are kept, not deleted; retention is release gate 15.
- **Derived counts are recomputed, never added to.** `event_aggregates` holds the number of events per project and UTC hour, written by a job that counts the events themselves and replaces the stored number, so a retry, a replay or a crash cannot count anything twice. The application can read, insert and change only the count, and cannot delete ([ADR 0013](../architecture/decisions/0013-event-processing.md)). Events carry the id of the batch they arrived in (`batch_id`), which is what the job points at.
- **A repository's graph is a snapshot, and a snapshot is never changed.** `analysis_runs` holds one analysis of one project, and `graph_nodes` and `graph_edges` hold what it found (files, packages, routes, environment variable names, imports), written in one transaction with the run, so a run that can be read is whole. The application can insert and read them and cannot update or delete; a newer analysis is a new run, and the latest run of a project is the graph now. Every key and foreign key carries `organisation_id`, so a node or an edge cannot point into another tenant's run. The run's id, chosen by the caller, is the idempotency key. A run of 20,000 files is about 30 MB and the largest that the schema allows is about 133 MB, and there is no deletion path yet (release gate 15) ([ADR 0026](../architecture/decisions/0026-system-graph-storage.md)).
- **A project is a repository through a connection, and an analysis is asked for by a request.** `repository_connections` says which GitHub installation, owner and name a project is (one for each project, never changed) and `analysis_requests` is one request to analyse it at a ref; its id is also the id of the job that does it and of the run that it stores, and how it is going is read from the job and the run, not stored. `github_installations` says which installations belong to which organisation, and **only an operator writes it**: the app's token reaches whatever the installation can see, so a tenant must not be able to name an installation that is not its own. It is the one table whose unique constraint spans tenants, which the schema guard allows only for tables that an operator writes ([ADR 0031](../architecture/decisions/0031-connecting-a-repository-and-asking-for-an-analysis.md)).
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

**Built so far:** the part that comes from a repository (files, packages, modules, routes, environment variables and frameworks, with imports, dependencies and definitions), as `analysis_runs`, `graph_nodes` and `graph_edges`. The rest (services, tables, deployments, incidents, ownership) comes from the runtime and is planned.

Represented as relational tables with graph-oriented relationships first. A dedicated graph store is considered only when measured query needs justify it.
