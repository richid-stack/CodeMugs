# @codemugs/auth

Organisations, projects, API keys and the audit log.

**Status:** Phase 1 · Foundation (started). What exists: organisations and projects as records, project-scoped API keys, authentication by key, and an append-only audit log. Role-based access control, service accounts, OIDC and people-facing sign-in do not exist yet.

Decision: [ADR 0010](../../docs/architecture/decisions/0010-api-keys-and-audit-log.md). It builds on [ADR 0006](../../docs/architecture/decisions/0006-tenant-isolation.md), and its tables live in [`@codemugs/storage`](../storage/README.md).

## What is here

- `authenticateApiKey(pool, presentedKey)`: returns `{ organisationId, projectId, apiKeyId }` or `undefined`. Malformed, unknown, wrong-secret and revoked keys are the same answer. A database failure throws instead.
- `createOrganisation`, `createProject`, `issueApiKey`, `revokeApiKey`: each writes its audit entry in the same transaction. `issueApiKey` returns the key once; only a SHA-256 of its secret is stored.
- `recordAudit(client, entry)`: appends to the audit log inside a tenant transaction. The organisation is the one the transaction acts for and cannot be chosen.
- `generateApiKey`, `parseApiKey`, `hashSecret`: the key format, without a database.

A key looks like `cmk_<organisation id>_<key id>_<secret>` (113 characters). The organisation id is in the key so the lookup can run under that organisation's tenant transaction with row-level security still on.

## Rules

- **These functions do not check who is calling them.** They are internal. Whatever exposes them (an API route, an administration tool) must decide who may, and the tenant must come from the caller's credential, never from a request body, query string or event payload.
- **Never log, store or put an API key in the audit metadata.** Audit metadata is small, flat and free of secrets and personal data.
- **A failed or unknown key is one answer.** Do not distinguish the reasons to a caller.

## Running the tests

The unit tests need nothing. The database tests need the same setup as `@codemugs/storage` (see its README) and are skipped when `CODEMUGS_TEST_DATABASE_URL` is not set.

```bash
pnpm build   # the tests use the built storage package and its test helpers
pnpm --filter @codemugs/auth test
```

## Not done yet

Rate limiting of unauthenticated attempts, key scopes, key expiry and rotation, a pepper for the stored hashes, and an administration path to create organisations, projects and keys. See ADR 0010.
