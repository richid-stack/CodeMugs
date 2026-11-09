# API conventions

The first section describes what the API does today. The second proposes conventions for everything built next, so they can be agreed before routes multiply.

## Implemented today

- **Request IDs.** Every response carries `x-request-id`. A caller-supplied value is honoured only if it is 8 to 64 characters of letters, digits, underscores and hyphens.
- **One error shape** for every failure:

  ```json
  { "error": { "code": "not_found", "message": "Route not found", "requestId": "..." } }
  ```

  Server errors always return `internal_error` with a generic message. Details go to logs.

- **Health.** `GET /healthz` (liveness) and `GET /readyz` (readiness), unversioned and public. See [apps/api](../../apps/api/README.md).
- **Versioned paths.** Everything else lives under `/v1`.
- **JSON only.** Any other content type gets `415`.
- **Ingestion.** `POST /v1/events` takes a batch and returns a result for each event. The client-generated `eventId` is the idempotency key, per project, so a retried batch is safe. `202` means the batch was understood, `5xx` means retry. See [apps/api](../../apps/api/README.md).
- **Stable error codes for bad bodies:** `invalid_json`, `payload_too_large`, `unsupported_media_type`, `invalid_request`, and the batch codes `body_not_an_object`, `events_missing`, `events_empty`, `too_many_events`.
- **Authentication.** Every `/v1` route requires an API key as a bearer token. The key determines the organisation and project, and a tenant identifier in a header or the query string is ignored. All credential failures return the same `401`. A failure of the authentication system itself returns `500` or `503`, never `401`. Authenticated responses are `cache-control: no-store`. Details and gaps (no rate limiting yet) are in [apps/api](../../apps/api/README.md).
- **Security headers** via `@fastify/helmet`, and a request body size cap.

## Proposed

These are not implemented and not yet agreed.

- **ISO 8601 timestamps in UTC** everywhere. Event timestamps already require an offset.
- **OIDC for people.** API keys are for SDK ingestion and service use. Signing in people is not built.
- **No tenant or project identifiers in request bodies or event payloads.** Each endpoint that accepts a body enforces this in its own schema. The first one will be ingestion.
- **Idempotency for other mutating requests.** An `Idempotency-Key` header, where a repeated key returns the original result. Ingestion already uses `eventId`.
- **Pagination.** Cursor-based, with a bounded page size.
- **Stable machine-readable error codes everywhere**, documented, and never repurposed. The codes above are the first ones.
- **Rate limits** per tenant, communicated with response headers, with `429` and a retry hint.
- **OpenAPI** generated from the same schemas used for validation, so the documentation cannot drift from the behaviour.
- **Deprecation policy.** A published window before removing anything from a public version.

## Open

See [gap 11](../architecture/open-questions.md): which interfaces are public, and the versioning and deprecation commitments that come with that.
