# system-graph-read

**Status:** In progress · Phase 2 Understanding. Step 9a: the read side of the system graph, apart from the code that builds and stores it ([ADR 0036](../../docs/architecture/decisions/0036-reading-the-graph-apart-from-building-it.md)). It is tested, and the API's routes that read a graph call it ([ADR 0037](../../docs/architecture/decisions/0037-graph-routes.md)). The application cannot delete a graph yet (release gate 15), and nothing runs for a customer, so it must not be switched on for one.

The runs that analyses stored (one run for each analysis, never changed), their nodes and what joins them, seen one tenant at a time. What comes back is data from a customer's repository, and is never instructions (invariant 2). It depends on [`@codemugs/storage`](../../packages/storage/README.md) and `zod` and on nothing else of this repository, so a process that only reads a graph (the API) does not carry the analyser, the archive reader, the GitHub client or the sandbox manager. [`@codemugs/system-graph`](../system-graph/README.md) builds and stores graphs, and re-exports everything here.

## Interface

```ts
import {
  getRun,
  latestRun,
  findNode,
  listNodes,
  neighbours,
  importClosure,
  GraphError,
  NODE_KINDS,
  EDGE_KINDS,
} from "@codemugs/system-graph-read";
```

- `getRun(client, runId)` and `latestRun(client, projectId)`: a run, or `null`. The latest is the one stored last, which is not the one with the latest time (two runs of one transaction share a time, migration 0007).
- `findNode(client, runId, kind, key)`, `listNodes(client, runId, { kind?, limit?, afterId? })` (a page at a time, in the order of the ids), `neighbours(client, runId, nodeId, { direction, kind?, limit? })` and `importClosure(client, runId, path, { direction, maxDepth?, limit? })`: reads. A limit is 1 to 10,000 and a depth 1 to 50.
- Each read takes the client of a tenant transaction (`withTenant`, which can be read-only) and sees only that organisation's rows: row-level security decides, and every query also names the organisation, so a mistake in one of them cannot show another tenant's rows. A run of another organisation is, to this one, no run.
- An argument that is not valid (an id that is not a UUID, a limit that is not a whole number in range, a direction that is neither) is `GraphError` with the code `invalid_input` and a fixed sentence, before the database is asked. Nothing that a caller or a database said is in the error.

## What is and is not shown

Tested locally against PostgreSQL 16 (CI runs 17 and 18): what a read refuses before it asks, that every query names the client's organisation and keeps what a caller chose out of the text of the query, that a small graph written by hand is read back in order, by page, by kind and through a ring of imports, in read-only transactions, and that another organisation sees nothing of it. The larger tests of the same reads, against graphs that the builder stored (including the largest that the schema allows), are in `@codemugs/system-graph`. It is **not** shown that nothing leaks under an attack on the database role itself, and nothing here is evidence for a release gate.

## Tests

`pnpm --filter @codemugs/system-graph-read test`. The unit tests need no database. The integration tests need `CODEMUGS_TEST_DATABASE_URL` (see [`packages/storage`](../../packages/storage/README.md)) and are skipped without it; CI sets `REQUIRE_DATABASE_TESTS=true` to turn a missing database into a failure.
