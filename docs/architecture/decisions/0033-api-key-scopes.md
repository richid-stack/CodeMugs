# 0033. API key scopes

- **Status:** Accepted
- **Date:** 2026-11-21

## Context

[ADR 0010](0010-api-keys-and-audit-log.md) made an API key identify an organisation and a project, and said "there are no scopes yet". That was enough while the API did one thing with a key: take events. The next routes read what the platform found in a customer's code and ask for an analysis of it. The key that takes events is the key of an SDK, which sits in an application that other people can read; a key that can also read the structure of the code, or spend a download and a sandbox run, has to be a different key, with a different place to keep it. If both are one key, every SDK key is a read key for the repository graph.

## Decision

1. **A key has scopes, fixed when it is issued.** The scopes are `events:write` (send events), `analysis:write` (connect a project to a repository and ask for an analysis) and `analysis:read` (read what the analyses found). None includes another: a key that writes analyses cannot read them unless it was given both. A key has at least one scope.
2. **A key that is issued with no scopes named may only send events.** That is what every key could do before, so existing keys keep exactly their power (the migration gives them `events:write`), and a caller that says nothing gets the least that has ever been useful.
3. **The application cannot change the scopes of a key.** It can insert a key with scopes and update only `revoked_at`, as before. A key that needs more is revoked and replaced, and the audit log carries both the issue (with the scopes) and the revocation.
4. **The database refuses a list that is empty, or has a scope it does not know,** and the library refuses the same before it asks. Adding a scope is a migration, so it is a reviewed change to what a key may mean. A scope that the code does not know and the database holds (a later version wrote it) is dropped when the key is read and never granted.
5. **A route names the scope it needs, and the check comes before the body is read.** A key that lacks it gets `403 forbidden` with a message that names the scope, from a hook that runs before the body is parsed, so a key that may not do the thing has its body neither read nor looked at. Authentication is checked first, so a request with no valid key is still `401` and says nothing about scopes. `GET /v1/whoami` shows the key's scopes, so an SDK can check a key without sending data.
6. **`POST /v1/events` needs `events:write`.** Every key issued so far has it.

## Rejected alternatives

- **Roles (reader, writer, admin).** A role would bundle what a key may do into a word that grows. Two kinds of key already differ by one thing each (an SDK needs only to send; a service that reads needs only to read), and a scope says exactly that.
- **Scopes that can be changed on a key.** It would let the application widen a key that was issued for an SDK, so a bug or a stolen session could turn a harmless key into one that reads a customer's code. The replacement of a key is cheap and leaves a record.
- **No scopes, with the read routes protected by something else.** There is nothing else yet: people have no sign-in and keys are the only credential.

## Consequences

- **The scopes are not a complete authorization model.** They say what a key may do to its own project; they say nothing of which of the organisation's projects a key may reach (a key belongs to one project), of a person, or of an operator. Sign-in for people is not built.
- **Nothing issues a key over HTTP.** `issueApiKey` is internal, so a key with `analysis:*` scopes is made by an operator, who has to choose them on purpose.
- **Key expiry and rotation are still open** ([ADR 0010](0010-api-keys-and-audit-log.md)); a key with `analysis:read` does not expire.
- **A key is not told its scopes when it is issued;** it can ask `GET /v1/whoami`.
- **What was run.** Locally, on PostgreSQL 16, `pnpm verify` passed with the database tests required, none skipped: 124 tests in `@codemugs/auth` and 106 in `@codemugs/api`, 154 in `@codemugs/storage`. The tests show that a key has the scopes it was issued with and nothing more, that none named means only events, that an empty list, an unknown scope or the wrong type is refused by the library and by the database, that the application role cannot update the scopes (`42501`), that a scope the code does not know is dropped when a key is read, that a key without `events:write` gets `403` before its body is read and before the route says whether it is available, and that the scopes are in the audit entry of the issue. 23 deliberate bugs were put into the code, the hook and the migration one at a time (the check always passing, the check after the body, the wrong scope required, every key given every scope, the database allowing an empty or unknown list, the application allowed to update the scopes) and every one was caught. CI runs it on PostgreSQL 17 and 18, and what it ran is in the pull request and is not claimed here.
