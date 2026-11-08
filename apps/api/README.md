# @codemugs/api

The control plane's HTTP API. Health endpoints, API key authentication for everything under `/v1`, and one endpoint behind it (`GET /v1/whoami`). No business endpoints yet.

**Status:** Phase 1 · Foundation (started)

## Endpoints

| Route            | Purpose                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`   | Liveness. The process is up. Never checks dependencies, so a database outage cannot trigger restarts                                                       |
| `GET /readyz`    | Readiness. Runs registered dependency checks with timeouts and returns `503` if any fail or shutdown has begun. Failure details are logged, never returned |
| `GET /v1/whoami` | Requires an API key. Returns the `organisationId`, `projectId` and `apiKeyId` the key belongs to, so an SDK can check a key without sending data           |

## Behaviour

- Every response carries `x-request-id`. A caller-supplied ID is honoured only if it matches a safe pattern; otherwise one is generated.
- One error shape for every failure: `{ "error": { "code", "message", "requestId" } }`. Server errors return a generic message.
- Baseline security headers via `@fastify/helmet`.
- Request body size is capped by `BODY_LIMIT_BYTES`.
- Auth headers and cookies are redacted from logs.
- On `SIGTERM` or `SIGINT`: readiness flips to `503`, in-flight requests drain, and the process exits. A forced exit follows after `SHUTDOWN_TIMEOUT_MS`.
- Invalid configuration fails at startup and names the variables at fault, never their values.

## Authentication

Everything under `/v1` requires `Authorization: Bearer <api key>`. Health routes stay public. The check is a hook on the scope that holds the `/v1` routes, so a route added there is protected without anyone remembering to protect it, and a test fails if a `/v1` route exists outside that scope.

- **The tenant comes from the key and nowhere else.** The organisation, project and key ids on `request.principal` are what the database says the key belongs to. A tenant id in a header or the query string is ignored (tested). Rejecting tenant ids in request bodies belongs to the schema of each endpoint that accepts a body, starting with ingestion.
- **Every credential failure looks the same.** Missing header, wrong scheme, malformed key, unknown key, wrong secret and revoked key all give `401` with the same body and `www-authenticate: Bearer realm="codemugs"`. The log says only that authentication failed, never why and never the key.
- **A failure to decide is not a failure to authenticate.** If the database cannot answer, the request gets a generic `500`, never a `401`, so an outage cannot look like a revoked key to an SDK that then discards the key.
- **Without a database there is no authentication.** If `DATABASE_URL` is not set (allowed outside production), every `/v1` route answers `503 authentication_unavailable`, even for a request that presents a key.
- Authenticated responses carry `cache-control: no-store`, and every log line for the request carries `organisationId`, `projectId` and `apiKeyId`.

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
