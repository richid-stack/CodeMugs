# @codemugs/api

The control plane's HTTP API. Health endpoints, API key authentication for everything under `/v1`, and the endpoints behind it: `GET /v1/whoami`, `POST /v1/events` (event ingestion, for keys with the `events:write` scope) the routes that connect a repository and ask for it to be analysed (`analysis:write`, `analysis:read`) and the routes that read the graph that an analysis found (`analysis:read`). Nothing reads events back yet. The analysis routes record and queue; the process that does the analysis is [`@codemugs/analysis-worker`](../analysis-worker/README.md), a separate process. The graph is read through [`@codemugs/system-graph-read`](../../core/system-graph-read/README.md), so the API holds no analyser.

**Status:** Phase 1 · Foundation (started)

## Endpoints

| Route                                                                                                         | Purpose                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                                                                                | Liveness. The process is up. Never checks dependencies, so a database outage cannot trigger restarts                                                                                                                                           |
| `GET /readyz`                                                                                                 | Readiness. Runs registered dependency checks with timeouts and returns `503` if any fail or shutdown has begun. Failure details are logged, never returned                                                                                     |
| `GET /v1/whoami`                                                                                              | Requires an API key. Returns the `organisationId`, `projectId`, `apiKeyId` and `scopes` of the key, so an SDK can check a key without sending data                                                                                             |
| `POST /v1/events`                                                                                             | Requires an API key with the `events:write` scope (ADR 0033). Records a batch of 1 to 500 events and says what happened to each (see below)                                                                                                    |
| `POST /v1/repository`, `GET /v1/repository`                                                                   | `analysis:write` to say which GitHub repository the key's project is (once), `analysis:read` to read it back (ADR 0034)                                                                                                                        |
| `GET /v1/graph`, `GET /v1/analyses/:id/graph`, `…/nodes`, `…/node`, `…/nodes/:nodeId/neighbours`, `…/imports` | `analysis:read`. The graph of the key's project as it is now, and what one analysis found: its nodes a page at a time, one node by kind and key, what a node is joined to, and the files that a change to a file reaches (see below, ADR 0037) |
| `POST /v1/analyses`, `GET /v1/analyses`, `GET /v1/analyses/:id`                                               | `analysis:write` to ask for an analysis at a `ref` (`202`, a worker does it later), `analysis:read` to list them and to see how one is going (ADR 0034)                                                                                        |

## Reading a graph

All of these need `analysis:read` and are for the key's own project: a run that is another project's, another organisation's or not there is the same `404 graph_not_found`, word for word. The `:id` is the analysis's id, which is also its run's ([ADR 0032](../../docs/architecture/decisions/0032-the-job-that-analyses-a-repository.md)). A route takes the query parameters below and no others (a project or an organisation in the query is `400 invalid_input`, and so is a parameter given twice).

| Route                                           | Parameters                                                                                                                                           | Answers                                                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/graph`                                 | none                                                                                                                                                 | `{ run }` of the run stored last, or `404 graph_not_found` if the project has none                                               |
| `GET /v1/analyses/:id/graph`                    | none                                                                                                                                                 | `{ run }`: the revision, the number of nodes and edges, what was cut short, a summary and a digest                               |
| `GET /v1/analyses/:id/nodes`                    | `kind`, `limit` (1 to 1,000, default 100), `after` (a node id)                                                                                       | `{ nodes, next? }` in the order of the ids; pass `next` as `after` for the next page                                             |
| `GET /v1/analyses/:id/node`                     | `kind` and `key`, both required                                                                                                                      | `{ node }`, or `404 node_not_found`                                                                                              |
| `GET /v1/analyses/:id/nodes/:nodeId/neighbours` | `direction` (`out`, the default, or `in`), `edge` (an edge kind), `limit`                                                                            | `{ neighbours: [{ edge, node }] }`, empty for a node with no edges, `404 node_not_found` for a node that is not there            |
| `GET /v1/analyses/:id/imports`                  | `path` (a file's key) and `direction` (`importers`: what a change reaches, `imports`: what it depends on), both required; `depth` (1 to 50), `limit` | `{ files: [{ id, kind, key, attributes, depth }] }`, nearest first, or `404 node_not_found` if the path is not a file of the run |

A node's `id` is a number within one run and is not the same in another run: to follow the same thing from one analysis to the next, use its `kind` and `key`. A list that has exactly `limit` entries may have been cut (only `nodes` has a cursor), so ask again with a larger `limit`. What comes back are names from a customer's repository, which are data and never instructions (invariant 2): a program that gives them to a person or to a model must treat them so.

## Behaviour

- Every response carries `x-request-id`. A caller-supplied ID is honoured only if it matches a safe pattern; otherwise one is generated.
- One error shape for every failure: `{ "error": { "code", "message", "requestId" } }`. Server errors return a generic message.
- Baseline security headers via `@fastify/helmet`.
- Request body size is capped by `BODY_LIMIT_BYTES`.
- Auth headers and cookies are redacted from logs.
- On `SIGTERM` or `SIGINT`: readiness flips to `503`, in-flight requests drain, and the process exits. A forced exit follows after `SHUTDOWN_TIMEOUT_MS`.
- Invalid configuration fails at startup and names the variables at fault, never their values.

## Sending events

```http
POST /v1/events
Authorization: Bearer <api key>
Content-Type: application/json

{ "events": [ { "schemaVersion": 1, "eventId": "<uuid>", "type": "checkout.completed",
                "occurredAt": "2026-11-09T01:00:00Z", "environment": "production",
                "sdk": { "name": "sdk-js", "version": "1.0.0" }, "attributes": {} } ] }
```

The response is `202` when the batch was understood, with a result for every event in the order sent:

```json
{
  "accepted": 1,
  "duplicates": 1,
  "rejected": 1,
  "results": [
    { "index": 0, "eventId": "...", "status": "accepted" },
    { "index": 1, "eventId": "...", "status": "duplicate" },
    { "index": 2, "status": "rejected", "reason": "invalid_event", "field": "type" }
  ]
}
```

- **An SDK drops rejected events and retries only on `5xx`.** A rejection cannot be fixed by sending the event again. Reasons are listed in [`@codemugs/ingestion`](../ingestion/README.md).
- **A retry is safe.** The event id is the idempotency key, per project. A repeated event comes back as `duplicate` and is not stored twice, even when two copies arrive at once. The first copy wins, so a retry with different content is not detected.
- **`accepted` means committed.** If the database cannot record the batch the answer is `500` and nothing from it was stored.
- A batch that cannot be read at all gets `400` with one of `body_not_an_object`, `events_missing`, `events_empty` or `too_many_events`. Other request errors are `400 invalid_json`, `413 payload_too_large` and `415 unsupported_media_type` (only `application/json` is accepted).
- The tenant, the project and the key an event is recorded under come from the API key. Nothing in the request can change them.

Not done: nothing reads events back or processes them yet, events are not redacted, and there are no rate limits or quotas ([ADR 0011](../../docs/architecture/decisions/0011-event-ingestion.md)).

## Authentication

Everything under `/v1` requires `Authorization: Bearer <api key>`. Health routes stay public. The check is a hook on the scope that holds the `/v1` routes, so a route added there is protected without anyone remembering to protect it, and a test fails if a `/v1` route exists outside that scope.

- **The tenant comes from the key and nowhere else.** The organisation, project and key ids on `request.principal` are what the database says the key belongs to. A tenant id in a header or the query string is ignored (tested). Rejecting tenant ids in request bodies belongs to the schema of each endpoint that accepts a body, starting with ingestion.
- **Every credential failure looks the same.** Missing header, wrong scheme, malformed key, unknown key, wrong secret and revoked key all give `401` with the same body and `www-authenticate: Bearer realm="codemugs"`. The log says only that authentication failed, never why and never the key.
- **A failure to decide is not a failure to authenticate.** If the database cannot answer, the request gets a generic `500`, never a `401`, so an outage cannot look like a revoked key to an SDK that then discards the key.
- **Without a database there is no authentication.** If `DATABASE_URL` is not set (allowed outside production), every `/v1` route answers `503 authentication_unavailable`, even for a request that presents a key.
- Authenticated responses carry `cache-control: no-store`, and every log line for the request carries `organisationId`, `projectId` and `apiKeyId`.
- **Logs hold no event content.** A database error is logged as its kind, SQLSTATE and the table, column and constraint involved, without the failing row or the JSON PostgreSQL quotes, which can be customer data.

Not done yet: **rate limiting.** A well-formed but wrong key costs one short database transaction ([ADR 0010](../../docs/architecture/decisions/0010-api-keys-and-audit-log.md)), so this API must not be exposed to the internet until limits exist at the edge or in the API. There are also no key scopes, expiry or rotation, and nothing that creates organisations, projects or keys over HTTP: those functions in [`@codemugs/auth`](../../packages/auth/README.md) are reachable only from code.

## Configuration

| Variable              | Default       | Notes                                                                                                                                                                                                                                                                         |
| --------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`            | `development` | `development`, `test` or `production`                                                                                                                                                                                                                                         |
| `HOST`                | `127.0.0.1`   | The container image sets `0.0.0.0`                                                                                                                                                                                                                                            |
| `PORT`                | `3000`        |                                                                                                                                                                                                                                                                               |
| `LOG_LEVEL`           | `info`        | `fatal` to `trace`, or `silent`                                                                                                                                                                                                                                               |
| `SHUTDOWN_TIMEOUT_MS` | `10000`       |                                                                                                                                                                                                                                                                               |
| `BODY_LIMIT_BYTES`    | `1048576`     |                                                                                                                                                                                                                                                                               |
| `DATABASE_URL`        | unset         | `postgres://` or `postgresql://`, for the restricted application role, never a superuser. Required when `NODE_ENV` is `production`. Held as a secret: it cannot be printed or logged by accident, and errors name the variable, not the value. An empty value counts as unset |

Migrations are not run by the API. They need a privileged role and run as a separate step ([ADR 0009](../../docs/architecture/decisions/0009-data-access-and-migrations.md)). With a database configured, `GET /readyz` also checks that the connection works, that `api_keys` exists and that the application role can use it. A connection attempt gives up after five seconds.

## Adding a dependency check

```ts
const { app } = await buildApp({
  config,
  readinessChecks: [{ name: "cache", check: () => cache.ping(), timeoutMs: 1000 }],
});
```

## Adding an authenticated route

Register it inside the scope in `src/routes/v1.ts`. Read the caller from `request.principal`, and use `principal.organisationId` for every database call (`withTenant`). Never read a tenant from the request.

## Commands

```bash
pnpm --filter @codemugs/api dev     # run with reload
pnpm --filter @codemugs/api test    # run tests (database tests need CODEMUGS_TEST_DATABASE_URL)
pnpm --filter @codemugs/api build   # compile to dist/
```
