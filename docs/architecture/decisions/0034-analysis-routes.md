# 0034. The routes that connect a repository and ask for an analysis

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

[ADR 0031](0031-connecting-a-repository-and-asking-for-an-analysis.md) made the API the side that records and queues, and [ADR 0033](0033-api-key-scopes.md) gave a key the scopes `analysis:write` and `analysis:read`. This ADR is the routes that use both.

## Decision

1. **Five routes under `/v1`, for the project of the key.** The organisation and the project are the credential's, so no path or body names one (invariant 1).

   | Route                  | Scope            | Does                                                                                                                   |
   | ---------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
   | `POST /v1/repository`  | `analysis:write` | Says that the project is a GitHub repository (`installationId`, `owner`, `name`). Once: `201`, then `409`              |
   | `GET /v1/repository`   | `analysis:read`  | The repository that the project is, or `404 connection_not_found`                                                      |
   | `POST /v1/analyses`    | `analysis:write` | Asks for an analysis of a `ref`: `202` with `{ id, status: "queued" }` and a `Location` header                         |
   | `GET /v1/analyses`     | `analysis:read`  | The analyses of the project, newest first; `?limit=` of 1 to 100                                                       |
   | `GET /v1/analyses/:id` | `analysis:read`  | How one is going: `queued`, `running`, `retrying`, `succeeded`, `failed` or `unknown`, with a `failureCode` or a `run` |

   A `202` means "will be done": the request and the job are written in one transaction and a worker of its own does the rest.

2. **A body has the fields that the route takes and no others.** A body that names a project, an organisation or anything else is `400 invalid_input`, not ignored, so that a client that thinks it chose a project is told that it did not. The service passes the credential's project last, so that nothing in its input can replace it even if a route let one through, and a test of the service alone shows it.

3. **What is not the key's project's is not found.** An analysis of another organisation, of another project of the same organisation and one that does not exist are the same `404 analysis_not_found`. An installation that belongs to another organisation and one that nobody has are the same `404 installation_not_found`. The route does not say which exist.

4. **Failures are codes, in the API's words.** A `RepositoryAnalysisError` becomes a status and a fixed sentence of the API's own (`400 invalid_input`, `404 project_not_found`, `404 installation_not_found`, `409 connection_exists`, `404 connection_not_found`), and nothing that the caller sent comes back. Any other error is a generic `500` and goes to the log. The `failureCode` of an analysis is the short code that the worker recorded (ADR 0032), never a message.

5. **The API holds no analyser.** It depends on `@codemugs/repository-analysis`, which reaches neither GitHub nor the sandbox, and not on `@codemugs/system-graph`, whose package depends on the analyser (and through it on the TypeScript compiler and the sandbox manager). The image is built with `pnpm deploy --prod`, so a dependency on that package would put the compiler and the sandbox manager in the API's image, whether or not they ran. **So the graph itself is not read through the API yet.** `GET /v1/analyses/:id` says how many nodes and edges a run has, and what was cut short; the nodes and edges come in a later change that first separates the read side of the graph from the part that builds it. A test of the API's dependencies keeps these packages out (and was shown to fail when the graph package was added). The read side is separated in [ADR 0036](0036-reading-the-graph-apart-from-building-it.md).

## Consequences

- The routes work against a real database: tests show that a key sees only its own project, that a refused request writes nothing, that a request is recorded with its job, and that a key without the scope is refused before its body is read. They are not shown against a worker: nothing runs the job yet (the process that does is the next part).
- The process that runs the analysis, the installation-binding flow, rate limits, key expiry and a deletion path (release gate 15) do not exist, so none of this may be switched on for a customer.
- A client has no way to cancel a request or to ask again without making a second request (ADR 0031): asking twice is two analyses.
