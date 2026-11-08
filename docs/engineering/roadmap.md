# Roadmap

The full architecture is large. The risk is building every subsystem before proving the central idea, so the plan is organised around one complete vertical slice.

## First milestone

**Connect an application, understand it, detect a problem, investigate it, and produce a verified engineering change.**

1. A user connects a GitHub repository.
2. The platform inspects the code and discovers the application structure.
3. The user connects one deployed application, sending runtime signals through the SDK or OpenTelemetry.
4. The platform builds an initial application graph.
5. The intelligence engine identifies an anomaly and retrieves the relevant evidence.
6. The decision engine decides whether an investigation is justified.
7. An engineering agent receives the task and context, works in an isolated sandbox, and runs tests.
8. A reviewer checks the change and the platform prepares a pull request.
9. After approval and deployment, the platform monitors whether the outcome actually improved.

If this works reliably, the idea is real. Then expand to more languages, connectors and agents.

## Phases

| Phase                   | Deliverable                                                                                                                                                                                | State                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Architecture         | PRD, system design, threat model, data model, engineering standards                                                                                                                        | In progress. Architecture overview, decision records, standards, and drafts of the PRD, data model, threat model, data classification and API conventions exist. Drafts need owner review and the open questions need answers |
| 1. Foundation           | Tenancy, authentication, API, database, events, model gateway, security, sandbox policy model and driver interface ([ADR 0007](../architecture/decisions/0007-build-the-sandbox-early.md)) | Started. API skeleton, configuration and event schemas exist. Everything else not started                                                                                                                                     |
| 2. Understanding        | GitHub integration, repository analysis inside the sandbox, first sandbox driver, SDK, application graph                                                                                   | Not started                                                                                                                                                                                                                   |
| 3. Observability        | OpenTelemetry, logs, metrics, traces, signal correlation                                                                                                                                   | Not started                                                                                                                                                                                                                   |
| 4. Intelligence         | Anomaly detection, investigations, diagnosis, decision engine                                                                                                                              | Not started                                                                                                                                                                                                                   |
| 5. Engineering          | Agent orchestration, tests, reviews, pull requests, sandbox isolation proof (escape and resource-abuse tests)                                                                              | Not started                                                                                                                                                                                                                   |
| 6. Learning             | Evidence ledger, outcome evaluation, engineering memory                                                                                                                                    | Not started                                                                                                                                                                                                                   |
| 7. Production hardening | Load and security testing, recovery, cost controls, reliability                                                                                                                            | Not started                                                                                                                                                                                                                   |
| 8. Expansion            | More SDKs, connectors, deployments, enterprise capabilities                                                                                                                                | Not started                                                                                                                                                                                                                   |

## Where things run

The owner has no computer of their own for now, so everything is built and tested in the cloud. This is a working constraint, not a design choice.

| What                                                                                | Where                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writing code, unit tests, typecheck, lint, smoke test                               | The engineering cloud session (`pnpm verify`)                                                                                                                                                                                                |
| A real PostgreSQL for database and tenant isolation tests                           | A CI service container. It also runs in the engineering session: on 2026-11-07 PostgreSQL 18.6 started from an npm package as a non-root user, and row-level security could be enabled (feasibility check only, nothing is committed for it) |
| Anything that needs a container runtime or KVM (sandbox driver tests, image builds) | GitHub Actions. The engineering session has no container daemon and no KVM                                                                                                                                                                   |
| Review and approval                                                                 | Pull requests on GitHub, which work from a phone                                                                                                                                                                                             |

Consequences: sandbox work has a slower feedback loop (push, then wait for CI), and runner features such as KVM are not guaranteed (see [ADR 0007](../architecture/decisions/0007-build-the-sandbox-early.md)).

## First build steps (proposed, awaiting the owner's go-ahead)

Each step is one or more small pull requests that end with evidence: a test that fails if the thing is wrong, plus an updated release gate or decision record where relevant. Sizes are relative (S, M, L), not time estimates.

1. **Housekeeping.** Licence applied ([ADR 0008](../architecture/decisions/0008-functional-source-license.md)), OpenLobs removed as a design driver, this plan recorded. S
2. **Database foundation and tenant isolation.** Choose the PostgreSQL major version and data-access approach with a short spike, add migrations and the first tenant-scoped tables with row-level security, and write cross-tenant tests that fail when isolation is removed. Settles [ADR 0006](../architecture/decisions/0006-tenant-isolation.md). M
3. **Identity.** Organisations, projects, hashed API keys, tenant taken from the credential only, an append-only audit log. M
4. **Ingestion.** `POST /v1/events` with idempotency, fast acknowledgement, PostgreSQL-backed jobs, replay and crash-recovery tests. M
5. **Sandbox foundation** (in parallel with steps 2 to 4). Policy model and driver interface, hardened container driver, gVisor driver, first escape and resource-abuse tests in CI, versions pinned. L
6. **The demo application.** A small TypeScript application with deliberately seeded faults, used as the test subject and as the first labelled incidents. S
7. **Repository understanding.** A read-only GitHub App, analysis inside the sandbox, parsing, and the first application graph for CodeMugs and the demo application. L
8. **Model gateway.** Provider-independent adapters, structured output validation, cost accounting and budgets, and a mock provider for tests. M
9. **The first vertical slice** on the demo application: detect, investigate, decide, fix in the sandbox, verify independently, open a pull request, watch the outcome. L

Steps 2 and 5 go first because tenant isolation and the sandbox are the two things that cannot be retrofitted. Order and sizes will change as we learn. Update this list when they do.

Dates are intentionally absent. The target is a trustworthy platform, not a calendar.
