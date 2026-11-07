# API conventions

The first section describes what the API does today. The second proposes conventions for everything built next, so they can be agreed before routes multiply.

## Implemented today

- **Request IDs.** Every response carries `x-request-id`. A caller-supplied value is honoured only if it is 8 to 64 characters of letters, digits, underscores and hyphens.
- **One error shape** for every failure:

  ```json
  { "error": { "code": "not_found", "message": "Route not found", "requestId": "..." } }
  ```

  Server errors always return `internal_error` with a generic message. Details go to logs.

- **Health.** `GET /healthz` (liveness) and `GET /readyz` (readiness). See [apps/api](../../apps/api/README.md).
- **Security headers** via `@fastify/helmet`, and a request body size cap.

## Proposed

These are not implemented and not yet agreed.

- **Versioned paths** such as `/v1/...`. Health endpoints stay unversioned.
- **JSON only**, with ISO 8601 timestamps in UTC.
- **Authentication.** API keys as bearer tokens for SDK ingestion and service use. OIDC for people. The authenticated principal determines the tenant. No tenant or project identifiers are accepted from request bodies or event payloads.
- **Idempotency.** Ingestion uses the client-generated `eventId`. Other mutating requests accept an `Idempotency-Key` header, and a repeated key returns the original result.
- **Pagination.** Cursor-based, with a bounded page size.
- **Stable machine-readable error codes**, documented, and never repurposed.
- **Rate limits** per tenant, communicated with response headers, with `429` and a retry hint.
- **OpenAPI** generated from the same schemas used for validation, so the documentation cannot drift from the behaviour.
- **Deprecation policy.** A published window before removing anything from a public version.

## Open

See [gap 11](../architecture/open-questions.md): which interfaces are public, and the versioning and deprecation commitments that come with that.
