# system-graph

**Status:** In progress · Phase 2 Understanding. Step 7c: what a repository analysis found, stored in PostgreSQL with tenant isolation, and the reads over it. It is tested and **nothing calls it yet**: the job that analyses a repository and stores the graph is step 9, and the application cannot delete a graph yet (release gate 15), so it must not be switched on for a real customer. Decision: [ADR 0026](../../docs/architecture/decisions/0026-system-graph-storage.md).

The graph of one project's repository, made from the facts that [`@codemugs/application-intelligence`](../application-intelligence/README.md) produces: files, packages, modules, routes, environment variables and frameworks, and the imports, dependencies and definitions between them. What the runtime shows (services, tables, deployments, incidents) joins it later.

A graph is a **run**: one analysis, stored once and never changed. A newer analysis is a new run, and the latest run of a project is the graph now. The facts are a customer's names and are data, never instructions (invariant 2); no content and no value is in them.

## Interface

```ts
import {
  buildGraph,
  saveAnalysis,
  getRun,
  latestRun,
  findNode,
  listNodes,
  neighbours,
  importClosure,
} from "@codemugs/system-graph";
```

- `buildGraph(facts)`: a pure function from facts to nodes, edges and a digest. The same facts in any order give the same graph.
- `saveAnalysis(client, { runId, projectId, revision?, facts })`: stores a run, whole or not at all, in the transaction of `client` (a `TenantClient` from `withTenant`). The same `runId` with the same facts is a retry (`duplicate: true`); with other facts, or for another project, it is `run_conflict`.
- `getRun`, `latestRun(client, projectId)`, `findNode(client, runId, kind, key)`, `listNodes` (a page at a time), `neighbours(client, runId, nodeId, { direction, kind?, limit? })` and `importClosure(client, runId, path, { direction, maxDepth?, limit? })`: reads that see only the client's organisation. A limit is 1 to 10,000 and a depth 1 to 50.
- Errors are `GraphError` with a code (`invalid_input`, `facts_rejected`, `project_not_found`, `run_conflict`) and a fixed sentence that says nothing of the facts.

The tables are `analysis_runs`, `graph_nodes` and `graph_edges` ([migration 0006](../../packages/storage/migrations/0006_system_graph.sql)). The application can insert and read them and cannot update or delete.

## What is and is not shown

Tested locally against PostgreSQL 16 (CI runs 17 and 18): a tenant cannot read, write or point into another tenant's graph, the same run id in two organisations is two runs, a run is whole or absent, the tables cannot be changed, and the largest graph the analysis allows (20,000 files, 100,000 imports) is stored in a few seconds. It is **not** shown that nothing leaks under an attack on the database role itself, and nothing here is evidence for a release gate. Retention, deletion and what reads the graph are not built. See the ADR for what is not decided.

## Tests

`pnpm --filter @codemugs/system-graph test`. The builder's tests need no database. The rest need `CODEMUGS_TEST_DATABASE_URL` (see [`packages/storage`](../../packages/storage/README.md)) and are skipped without it; CI sets `REQUIRE_DATABASE_TESTS=true` to turn a missing database into a failure.
