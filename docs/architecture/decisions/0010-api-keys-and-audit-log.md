# 0010. API keys and the audit log

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

[Invariant 1](../../../AGENTS.md) says tenant identity comes from the authenticated credential and nowhere else. The first credential is an API key for SDK ingestion and service use ([API conventions](../../api/conventions.md)). Authenticating a key means reading it from the database before we know which tenant it belongs to, and [ADR 0006](0006-tenant-isolation.md) makes the database show nothing when no tenant is set. We also need a first audit log, because security-relevant changes must be recorded from the start (threat model, item 9).

## Decision

1. **A key looks like `cmk_<organisation id>_<key id>_<secret>`.** The organisation id and key id are 32 hexadecimal characters each and are identifiers, not secrets. The secret is 256 random bits as 43 base64url characters. The whole key is 113 characters.
2. **The lookup runs inside the tenant transaction of the organisation the key claims.** The claim is not trusted: row-level security means the key can only be found under the organisation that owns it, and the secret must still match. A key that claims another organisation, or one that does not exist, finds nothing. This is why the organisation id is in the key. The alternatives each add a way around isolation (see below).
3. **Only the SHA-256 of the secret is stored.** The secret is random and long, so a fast hash is appropriate; a slow password hash protects guessable secrets and this is not one. The comparison is constant time. There is no server-side pepper yet.
4. **A key belongs to one project.** A composite foreign key `(organisation_id, project_id)` to `projects` means a key can never point at another organisation's project, and a missing project and another organisation's project give the same error. There are no scopes yet.
5. **Revocation is permanent and keys are never deleted.** The application role can insert keys and update only `revoked_at`, and a trigger refuses to change `revoked_at` once it is set. A revoked key stays, so the audit trail still points at it.
6. **Every authentication failure is the same answer.** A malformed key, an unknown key, a wrong secret and a revoked key all return nothing. A database failure is not an answer: it throws, so an outage cannot be mistaken for "not authenticated" or "authenticated".
7. **The audit log is append-only and written in the same transaction as the change.** The application role can read and insert only. Triggers refuse updates, deletes and truncation, so they also stop roles that hold those privileges, including the privileged migration role. Organisation and project creation and key issue and revocation are recorded. The actor is `system`, `api_key`, `user` or `operator`, the metadata is a small flat object (at most 4 KiB), and an entry can only be written for the organisation the transaction acts for.
8. **The schema guard now checks three more rules mechanically:** a foreign key between tenant tables must include `organisation_id` on both sides, a unique index on a tenant table must include `organisation_id` (otherwise a clash reveals that another tenant holds a value), and an append-only table must not grant update or delete.

## Evidence so far

- On 2026-11-08, 65 storage tests and 83 auth tests passed against PostgreSQL 18.6 with database tests required. The auth tests were run five times in a row because key generation is random.
- Sixteen deliberate breakages were made one at a time (the foreign key without `organisation_id`, an allow-everything policy on `api_keys`, column and delete grants widened, the revocation trigger removed, update and delete granted on the audit log, the audit triggers removed, the audit insert and read policies loosened, the actor rule removed, a revoked key accepted, the secret not checked, the organisation id shape not checked, the foreign-key error leaking, the secret stored instead of its hash, and a second revocation allowed). Each was caught by at least one test, and the files were restored afterwards. This was a manual run and is not automated.
- CI runs the same tests on PostgreSQL 17 and 18. Its result is recorded on the pull request that accepted this decision.

## Consequences

- **Unauthenticated callers can cost a database transaction.** A well-formed but wrong key still causes one short tenant transaction. Rate limiting at the edge is needed before the API is exposed, and it does not exist yet.
- **Timing is not equalised end to end.** An unknown key is compared against a dummy hash, so the two paths do the same hashing work, but the database round trip dominates and the difference has not been measured.
- **No pepper.** If the database leaks, an attacker gets SHA-256 hashes of 256-bit secrets, which cannot practically be reversed. A pepper held outside the database would add a layer, and waits for secret management.
- **A key is shown once.** A lost key is revoked and replaced. There is no rotation workflow and no expiry yet.
- **These operations do not check who is calling them.** `createOrganisation`, `createProject`, `issueApiKey` and `revokeApiKey` are internal. An authorised API layer or an administrator tool has to wrap them, and until one exists they are only reachable from code. Nothing grants itself permission (invariant 4).
- **Audit integrity has limits.** Privileges and triggers protect against the application and against mistakes. A database administrator can disable the triggers, and there is no hash chain or external copy to make tampering detectable.
- **Organisations cannot be deleted** while audit entries reference them. Retention, deletion and offboarding ([open question 4](../open-questions.md)) need a designed, audited privileged path that does not exist yet.
- **The audit schema is not final.** Operator and break-glass access ([open question 3](../open-questions.md)) is undecided. The `operator` actor type lets such actions be recorded, but the fields it needs (approval, expiry, customer visibility) may change the schema.
- **Not recorded:** failed authentication (there is no tenant to attribute it to, and recording it would let unauthenticated callers write rows) and successful authentication (volume). The API logs that an authentication failed, without the reason or the key, in the operational log (not the audit log), and carries the caller's ids on the log lines of authenticated requests.

## Alternatives considered

- **A key with no organisation in it, found by a lookup that ignores row-level security.** That needs a role or function that bypasses the policy. With forced row-level security even a table owner is subject to it, so the bypass would have to be a superuser or `BYPASSRLS` role, which is exactly what ADR 0006 keeps away from the application.
- **A policy exception that lets the application read the key table without a tenant.** It would expose every tenant's key hashes to any code holding the application role.
- **bcrypt or Argon2 for the secret.** Unnecessary for a random 256-bit secret and adds latency to every request.
- **Signed tokens (for example JWTs).** They need signing-key management and a revocation list, and give nothing the random key does not.
- **Scopes per key now.** Deferred until the first endpoints that need different permissions (for example ingest versus read).

## Revisit when

Keys need scopes or expiry, operator access is decided, rate limiting or a secrets manager exists, or an external pooler is introduced.
