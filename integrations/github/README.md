# github

**Status:** Partly implemented · Phase 2 Understanding · step 7d-1 of [the roadmap](../../docs/engineering/roadmap.md)

The first connector: reading a repository with a GitHub App. [ADR 0027](../../docs/architecture/decisions/0027-github-app-read-only.md) is the decision and says what was and was not shown.

## What exists

A client for what the **CodeMugs Reader** app is allowed to do, and a check that it is set up as intended.

- **Signing in as the app** (`createAppJwt`): a JWT signed with the app's private key (RS256, issued a minute ago, good for nine), made for each request and never kept. A key that is not a PEM RSA key of at least 2,048 bits is `key_invalid`, and the message says that a client secret is not one.
- **A token for one repository** (`GitHubApp.createInstallationToken(installationId, repository)`): it takes only the name of one repository, and the permission is fixed at `contents: read`, so a wider token (another repository, another permission, "everything") cannot be asked for, by mistake or by a caller of plain JavaScript. The token lasts an hour and is a `Secret`, which prints as `[redacted]`.
- **Reading** (`InstallationClient`): the repository, the commit that a branch or tag names, and the repository as a gzipped tar. The download streams to a function that you give it, counts the bytes, hashes them and stops at a limit. It never extracts anything.
- **A check** (`runCheck`, and `node dist/main.js`): asks GitHub whether the key signs in as the app, whether the app, its installation and a token can do only what was meant, whether the repository can be read and downloaded, and whether a write is refused. It prints yes or no for each, and nothing that is secret. It is run by the [GitHub App check workflow](../../.github/workflows/github-app-check.yml) and is described in the [runbook](../../docs/operations/github-app-key.md).

## What the code does not trust

Everything that GitHub says is data (invariant 2): each answer is read to at most 1 MiB and checked against a schema before any of it is used, and a failure is a short code with a fixed sentence (`GitHubError`) that never holds what GitHub sent, what was given, or a key or a token. The token goes to the API and to nothing else: a download is a redirect to a host on a short allow-list (`codeload.github.com`), made by a request that carries none of our credentials, and the address of a download, which carries a credential of its own, is never put in an error.

## What does not exist yet

- **Extracting the archive.** The download gives bytes. Reading an archive that a customer controls needs its own bounded, hostile-input-tested reader, and runs where customer code may run (invariant 8). That is 7d-2, and it will connect fetching, extracting, staging and the analysis ([ADR 0025](../../docs/architecture/decisions/0025-analysis-in-the-sandbox.md)).
- **Anything that calls it for a customer.** The check is the only caller.
- **Webhooks, pull requests and any permission to write.** The app has none, and writing is a separate decision with a separate permission, never a widening of this one.
- **More than one run against a live GitHub.** The tests run against a fake GitHub on this machine, and the check has been run from `main` against GitHub itself once (2026-11-17), when every line passed ([ADR 0027](../../docs/architecture/decisions/0027-github-app-read-only.md)). Only this repository, which is public, has been read.

## Testing

```bash
pnpm --filter @codemugs/github test
```

The tests need no network and no database. They run a fake GitHub on a loopback port that verifies the JWT's signature and claims, refuses a token on the wrong route and any credential sent to the download host, and records every request. The key pairs are made when the tests run, so no key is in the repository.
