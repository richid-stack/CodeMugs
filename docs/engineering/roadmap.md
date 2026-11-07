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

| Phase                   | Deliverable                                                             | State                                                                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Architecture         | PRD, system design, threat model, data model, engineering standards     | In progress. Architecture overview, decision records, standards, and drafts of the PRD, data model, threat model, data classification and API conventions exist. Drafts need owner review and the open questions need answers |
| 1. Foundation           | Tenancy, authentication, API, database, events, model gateway, security | Started. API skeleton, configuration and event schemas exist. Everything else not started                                                                                                                                     |
| 2. Understanding        | GitHub integration, repository analysis, SDK, application graph         | Not started                                                                                                                                                                                                                   |
| 3. Observability        | OpenTelemetry, logs, metrics, traces, signal correlation                | Not started                                                                                                                                                                                                                   |
| 4. Intelligence         | Anomaly detection, investigations, diagnosis, decision engine           | Not started                                                                                                                                                                                                                   |
| 5. Engineering          | Agent orchestration, sandbox, tests, reviews, pull requests             | Not started                                                                                                                                                                                                                   |
| 6. Learning             | Evidence ledger, outcome evaluation, engineering memory                 | Not started                                                                                                                                                                                                                   |
| 7. Production hardening | Load and security testing, recovery, cost controls, reliability         | Not started                                                                                                                                                                                                                   |
| 8. Expansion            | More SDKs, connectors, deployments, enterprise capabilities             | Not started                                                                                                                                                                                                                   |

## Suggested next steps

1. **Phase 0 close-out:** review the PRD, data model and data classification drafts, answer the [open questions](../architecture/open-questions.md), settle [ADR 0006](../architecture/decisions/0006-tenant-isolation.md) with a short spike, and turn the threat model draft into owned, testable items.
2. **Database foundation:** pick a migration and query approach, add the first tenant-scoped tables, and write cross-tenant isolation tests before building anything on top.
3. **Authentication and tenancy:** organisations, projects, API keys, and an OIDC-compatible identity provider.
4. **Model gateway:** provider adapters, routing, structured output validation, token and cost accounting.
5. **Workflow spike:** decide when PostgreSQL-backed jobs stop being enough and Temporal is introduced (see ADR 0005).

Dates are intentionally absent. The target is a trustworthy platform, not a calendar.
