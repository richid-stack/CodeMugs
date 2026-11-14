# Decision records

| #                                                           | Decision                                                       | Status   |
| ----------------------------------------------------------- | -------------------------------------------------------------- | -------- |
| [0001](0001-record-architecture-decisions.md)               | Record architecture decisions                                  | Accepted |
| [0002](0002-hybrid-deployment.md)                           | Hybrid deployment                                              | Accepted |
| [0003](0003-integrate-existing-agent-runtimes.md)           | Integrate existing agent runtimes, own the orchestration       | Accepted |
| [0004](0004-typescript-first-python-where-it-earns-it.md)   | TypeScript first, Python where it provides a real advantage    | Accepted |
| [0005](0005-modular-monolith-and-postgres-first-storage.md) | Modular monolith and PostgreSQL-first storage                  | Accepted |
| [0006](0006-tenant-isolation.md)                            | Tenant isolation in the database                               | Accepted |
| [0007](0007-build-the-sandbox-early.md)                     | Build the sandbox early, as a foundation                       | Accepted |
| [0008](0008-functional-source-license.md)                   | License the engine under the Functional Source License         | Accepted |
| [0009](0009-data-access-and-migrations.md)                  | Data access, PostgreSQL versions and migrations                | Accepted |
| [0010](0010-api-keys-and-audit-log.md)                      | API keys and the audit log                                     | Accepted |
| [0011](0011-event-ingestion.md)                             | Event ingestion: the contract and the storage                  | Accepted |
| [0012](0012-jobs-and-cross-tenant-claiming.md)              | Jobs: a PostgreSQL queue, and how workers find work            | Accepted |
| [0013](0013-event-processing.md)                            | Event processing: one job per batch, recomputed hourly counts  | Accepted |
| [0014](0014-worker-process.md)                              | The worker process: two logins, checked before it starts       | Accepted |
| [0015](0015-migration-command.md)                           | The migration command: wrong login refused, failures by code   | Accepted |
| [0016](0016-sandbox-policy-and-driver-interface.md)         | The sandbox policy and driver interface: nothing implied       | Accepted |
| [0017](0017-hardened-container-driver.md)                   | The hardened container driver: every option written out        | Accepted |
| [0018](0018-gvisor-driver.md)                               | The gVisor driver: the same container under another kernel     | Accepted |
| [0019](0019-pin-github-actions.md)                          | Every GitHub Action pinned to a commit, and a check that fails | Accepted |
| [0020](0020-escape-and-abuse-tests.md)                      | Escape and abuse tests on both runtimes, from what was seen    | Accepted |
| [0021](0021-a-user-id-of-its-own-for-each-run.md)           | A user and group id of its own for each run                    | Accepted |
| [0022](0022-the-demo-application.md)                        | The demo application, correct on main, its faults kept outside | Accepted |
| [0023](0023-the-incident-catalogue.md)                      | The incident catalogue: exact-text faults, proven              | Accepted |

See [0001](0001-record-architecture-decisions.md) for the format and when to write one.
