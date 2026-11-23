# 0036. Reading the graph apart from building it

- **Status:** Accepted
- **Date:** 2026-11-23

## Context

[ADR 0034](0034-analysis-routes.md) (decision 5) kept the API from depending on `@codemugs/system-graph`, because that package depends on the analyser's schema and so, through `@codemugs/application-intelligence`, on the TypeScript compiler and the sandbox manager. The API's image is built with `pnpm deploy --prod`, so a dependency on that package would put both in the image, whether or not they ran. The graph was therefore not readable through the API, and that change was to come after the read side was separated from the part that builds and stores.

## Decisions

1. **The reads are a package of their own: `@codemugs/system-graph-read`** (`core/system-graph-read`). It holds the reads (`getRun`, `latestRun`, `findNode`, `listNodes`, `neighbours`, `importClosure` and their limits), the vocabulary of kinds, the types of what is read back, and `GraphError`. It depends on `@codemugs/storage` and `zod` and on nothing of the analyser, the archive reader, the GitHub client or the sandbox.
2. **`@codemugs/system-graph` keeps what builds and stores a graph** (`buildGraph`, `saveAnalysis`, and the types of what is built), and **re-exports everything of the reader**, so what already imports a name from it (the process that analyses repositories imports `GraphError`) is not changed. There is one `GraphError` class, in the reader, so that `instanceof` is the same from both. Its codes `facts_rejected`, `project_not_found` and `run_conflict` belong to storing and are in the reader's error type only because the class is one.
3. **Nothing about the data or the behaviour changes.** The same queries, the same limits, the same tables. This is a move of code, and the only new code is the tests of the reader and a test of the API's dependencies.
4. **A test keeps it that way.** The API's dependency test ([ADR 0034](0034-analysis-routes.md)) now also walks the reader's dependencies and requires that none of the forbidden packages is among them, and it still shows that the graph package would bring the analyser in.
5. **The reader is tested without the builder.** Its integration tests write a small graph by hand, as a superuser, and read it as the application role in read-only transactions, so they show that the reads need the tables and no builder, and that another organisation sees nothing of it. Its unit tests show what a read refuses before it asks the database, and that every query names the client's organisation and passes what a caller chose as a parameter. The larger integration tests of the same reads, which read what the real store wrote (including a graph of the largest size that the schema allows), stay in `@codemugs/system-graph` and call the reader.

## Consequences

- The routes that read a graph can now be built (the next change), and the API image will hold the reader and no analyser.
- The API could in principle call any function the reader exports, which are reads only. It still cannot write a graph: the writing is in a package it does not depend on, and the application role's grants are unchanged.
- Two packages must change together when the shape of a node or an edge changes. The builder's tests read back what it stored, so a mismatch is found there.
- Nothing here is shown against an attack on the database role, and nothing is evidence for a release gate. Retention and deletion of graphs (release gate 15) do not exist, so none of this may be switched on for a customer.
