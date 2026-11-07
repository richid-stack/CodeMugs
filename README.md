# CodeMugs

A platform that connects to an application, builds a structured understanding of it, detects problems, investigates them, and produces **verified** engineering changes.

> **Status: pre-alpha.** This repository is the project foundation. Nothing here is production-ready yet. Production readiness is earned through implementation, testing and evidence, tracked in the [release gates](docs/operations/release-gates.md). It is not a property of the technology stack.

**Scope.** CodeMugs is a full product. The engine comes first and there is no frontend yet, by design: once the engine is solid we will know exactly what the frontend needs to be.

## What exists today

| Piece                                                 | State                                                                                                                                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo, strict TypeScript, ESLint, Prettier, Vitest | Working                                                                                                                                                                             |
| `apps/api`                                            | Fastify skeleton: liveness and readiness endpoints, request IDs, structured logs, uniform error shape that hides internals, graceful shutdown                                       |
| `@codemugs/configuration`                             | Validated environment config. Errors name variables, never values                                                                                                                   |
| `@codemugs/event-schemas`                             | Ingestion event envelope and batch schemas. Tenant identity is never taken from the payload                                                                                         |
| Local dependencies                                    | Postgres (with pgvector) and Redis via Docker Compose                                                                                                                               |
| CI                                                    | GitHub Actions workflow for build, typecheck, lint, format, test, smoke test, dependency audit, secret scan and image build                                                         |
| Docs                                                  | Architecture overview, decision records, glossary, open questions, release gates, roadmap, and drafts of the PRD, data model, threat model, data classification and API conventions |

Every other directory in the tree is a **placeholder** whose README states its responsibility and target phase.

## Quick start

Requirements: Node 22, pnpm 10 (`corepack enable`), and Docker for the local dependencies.

```bash
pnpm install
pnpm build          # workspace packages are consumed from dist/, so build after changing one
pnpm verify         # build + typecheck + lint + format check + test + smoke test
pnpm dev:api        # run the API with reload (copy .env.example to .env to customise)
pnpm infra:up       # start Postgres and Redis locally
```

## Architecture in brief

Two planes: a **control plane** (organisations, projects, permissions, policies, orchestration) and a **data and intelligence plane** (ingest, understand, detect, investigate, decide, act). Five layers sit across them: ingestion, application understanding, intelligence and decision, autonomous engineering, and validation and learning.

Three things are protected throughout development:

1. **The intelligence engine owns the decisions.** Coding agents are replaceable workers.
2. **The Application Intelligence Graph is the foundation of understanding.** Structured context, not raw logs pasted into a model.
3. **Validation and learning are independent of the agents.** An agent saying it succeeded is not evidence that it did.

Details: [architecture overview](docs/architecture/overview.md) and [decision records](docs/architecture/decisions/).

## Repository layout

| Directory         | Purpose                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `apps/`           | Deployable processes: API, ingestion, webhook gateway, workers, scheduler, CLI                  |
| `core/`           | Domain engines: graph, correlation, anomaly detection, root cause, decisions, policy, learning  |
| `intelligence/`   | Context building, evidence ledger, reasoning, hypothesis testing, evaluation, memory, retrieval |
| `engineering/`    | Agent orchestration, sandboxing, git, tests, review, pull requests                              |
| `integrations/`   | Connectors to GitHub, OpenTelemetry, clouds, databases and other systems                        |
| `packages/`       | Shared libraries: SDKs, model gateway, auth, security, storage, schemas, configuration          |
| `infrastructure/` | Docker, database, messaging, observability, secrets, deployment                                 |
| `tests/`          | Integration, end-to-end, security, performance, reliability and agent evaluations               |
| `docs/`           | Architecture, security, engineering and operations documentation                                |

## Documentation

- [Architecture overview](docs/architecture/overview.md)
- [Roadmap and phases](docs/engineering/roadmap.md)
- [Engineering standards](docs/engineering/standards.md)
- [Product requirements (draft)](docs/product/prd.md)
- [Gaps and open questions](docs/architecture/open-questions.md)
- [Glossary](docs/architecture/glossary.md)
- [Data model (draft)](docs/data-model/overview.md)
- [Data classification (draft)](docs/security/data-classification.md)
- [API conventions](docs/api/conventions.md)
- [Threat model (draft)](docs/security/threat-model.md)
- [Release gates](docs/operations/release-gates.md)
- [GitHub repository setup](docs/engineering/repository-setup.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

Proprietary. Copyright (c) 2026 Richard Mensah, all rights reserved. See [LICENSE](LICENSE). The code can be read, but no licence is granted to use, copy, modify or distribute it (`"license": "UNLICENSED"` in `package.json`). The longer-term approach is an open question, see [gap 17](docs/architecture/open-questions.md).
