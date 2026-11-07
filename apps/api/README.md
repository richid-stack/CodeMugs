# @codemugs/api

The control plane's HTTP API. Currently a hardened skeleton: no business endpoints yet.

**Status:** Phase 1 · Foundation (started)

## Endpoints

| Route          | Purpose                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz` | Liveness. The process is up. Never checks dependencies, so a database outage cannot trigger restarts                                                       |
| `GET /readyz`  | Readiness. Runs registered dependency checks with timeouts and returns `503` if any fail or shutdown has begun. Failure details are logged, never returned |

## Behaviour

- Every response carries `x-request-id`. A caller-supplied ID is honoured only if it matches a safe pattern; otherwise one is generated.
- One error shape for every failure: `{ "error": { "code", "message", "requestId" } }`. Server errors return a generic message.
- Baseline security headers via `@fastify/helmet`.
- Request body size is capped by `BODY_LIMIT_BYTES`.
- Auth headers and cookies are redacted from logs.
- On `SIGTERM` or `SIGINT`: readiness flips to `503`, in-flight requests drain, and the process exits. A forced exit follows after `SHUTDOWN_TIMEOUT_MS`.
- Invalid configuration fails at startup and names the variables at fault, never their values.

## Configuration

| Variable              | Default       | Notes                                 |
| --------------------- | ------------- | ------------------------------------- |
| `NODE_ENV`            | `development` | `development`, `test` or `production` |
| `HOST`                | `127.0.0.1`   | The container image sets `0.0.0.0`    |
| `PORT`                | `3000`        |                                       |
| `LOG_LEVEL`           | `info`        | `fatal` to `trace`, or `silent`       |
| `SHUTDOWN_TIMEOUT_MS` | `10000`       |                                       |
| `BODY_LIMIT_BYTES`    | `1048576`     |                                       |

## Adding a dependency check

```ts
const { app } = await buildApp({
  config,
  readinessChecks: [{ name: "database", check: () => db.ping(), timeoutMs: 1000 }],
});
```

## Commands

```bash
pnpm --filter @codemugs/api dev     # run with reload
pnpm --filter @codemugs/api test    # run tests
pnpm --filter @codemugs/api build   # compile to dist/
```
