# @codemugs/analysis-worker

The job that analyses a repository: it takes a request that [`@codemugs/repository-analysis`](../../core/repository-analysis/README.md) recorded, finds the commit, downloads it, has it analysed in the sandbox and stores the graph.

**Status:** In progress · Phase 2 Understanding, step 9a, fourth part. **The job and the process that runs it exist and are tested with stand-ins and in CI; nothing runs them for a customer.** There is no container image (how a process in a container reaches a sandbox is an [open question](../../docs/architecture/open-questions.md)), no deployment, no flow that binds an installation and no deletion path, so nothing may be switched on for one. Decisions: [ADR 0035](../../docs/architecture/decisions/0035-the-process-that-analyses-repositories.md) (the process), [ADR 0032](../../docs/architecture/decisions/0032-the-job-that-analyses-a-repository.md) (the job), [ADR 0031](../../docs/architecture/decisions/0031-connecting-a-repository-and-asking-for-an-analysis.md), [ADR 0014](../../docs/architecture/decisions/0014-worker-process.md).

It is a package of its own, and not part of `apps/worker`, because `apps/worker` never reads repository contents (ADR 0014) and the API must hold nothing that can reach GitHub (ADR 0031). It is the one place that holds, through what it is given, a key for GitHub and a way to the sandbox.

## The process

`pnpm --filter @codemugs/analysis-worker build`, then `node apps/analysis-worker/dist/main.js` (`pnpm dev` runs it with reload and reads `.env`). It is the one place that holds the GitHub App's key and the way to the sandbox.

1. Reads its settings and names every mistake at once, by variable and never by value, then **removes the key and the two database addresses from its environment**.
2. Checks, before it takes a job, in this order: the key can sign (without asking GitHub); the two database connections are the right roles with no more power than the role contract allows and can read what the job reads; the working folder can be written to; the sandbox driver can run here and isolates at least as much as was asked; and the image runs a fixed command of ours in the sandbox. A failure ends the process with exit code 1 and a log line with the variable and a code (`github_key_unusable`, `wrong_role`, `role_too_powerful`, `schema_not_ready`, `database_unreachable`, `workspace_unusable`, `sandbox_unavailable`, `sandbox_too_weak`, `sandbox_self_test_failed`).
3. Takes `repository.analyse` jobs, one at a time by default, until told to stop. `SIGTERM` or `SIGINT` takes no new job and waits for the ones in progress for `SHUTDOWN_TIMEOUT_MS`; an analysis still running then is abandoned and taken again when its lease ends.

| Variable                                                                                     | Default             | Notes                                                                                                                              |
| -------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`, `DISPATCHER_DATABASE_URL`                                                    | required            | The application role and the dispatcher role, as for [`apps/worker`](../worker/README.md). Different addresses                     |
| `CODEMUGS_GITHUB_APP_ID`, `CODEMUGS_GITHUB_APP_CLIENT_ID`, `CODEMUGS_GITHUB_APP_PRIVATE_KEY` | required            | [The app and its key](../../docs/operations/github-app-key.md). No installation: it is each request's                              |
| `ANALYSIS_SANDBOX_DRIVER`                                                                    | required            | `docker` or `gvisor`                                                                                                               |
| `ANALYSIS_SANDBOX_MINIMUM_ISOLATION`                                                         | required            | `hardened-container`, `gvisor` or `microvm`. Refused if the driver gives less                                                      |
| `ANALYSIS_SANDBOX_IMAGE`                                                                     | required            | Pinned by digest (`name@sha256:...`)                                                                                               |
| `ANALYSIS_WORKSPACE_ROOT`                                                                    | required            | An absolute path to a folder that exists. Working copies are made in it                                                            |
| `WORKER_CONCURRENCY`                                                                         | `1`                 | 1 to 8. Each analysis holds a sandbox of 1 CPU and 1 GiB                                                                           |
| `WORKER_LEASE_SECONDS`                                                                       | `600`               | At least 450, which is longer than the longest try can take: 3 requests of 30 s, a download of 120 s, the sandbox's 180 s and 60 s |
| `WORKER_POLL_INTERVAL_MS`, `SHUTDOWN_TIMEOUT_MS`, `LOG_LEVEL`, `NODE_ENV`                    | as in `apps/worker` |                                                                                                                                    |

The log is the same as the worker's: one JSON object per line, identifiers and codes only. Neither the key nor an address with a password is ever logged, and neither is what the sandbox or an error said.

## What the job does

`analyseJob(dependencies)` is a job that takes long ([ADR 0030](../../docs/architecture/decisions/0030-long-jobs.md)): no transaction is open while it works, and the graph is stored in the transaction that completes the job.

1. Reads the request's plan (installation, repository, ref) in the job's organisation. No such request: `request_not_found`, not tried again.
2. Opens a reader for that one repository (a token narrowed to it and to read access) and asks GitHub for the commit that the ref names now.
3. Downloads **that commit**, not the ref, and has it analysed. What it holds is untrusted data and nothing of it runs here (invariants 2 and 8).
4. Stores the run under the request's id, with the commit as its revision. The id is the key that makes a repeat harmless, so a job that runs twice stores one run.

What it needs is given to it: `openRepository` (`githubRepositories(app)` is the one that asks GitHub), `analyse` (the sandbox, its image and how much it must isolate are the process's to say, from its settings) and, if it is to be smaller than the unpacking's limit, `maxArchiveBytes`. `analysisHandlers(dependencies)` gives the handler for `repository.analyse`.

## How it fails

A failure is a short code and whether another try could do better; what GitHub, the sandbox or the database said is never kept (ADR 0012). `failureOf` is the table, and it is tested row by row. Not found, a download or output that is too large, a sandbox that is too weak, a timeout, an analyser fault and a refused run are not tried again; GitHub not answering, a refusal that may be a rate limit, a sandbox that failed and a bad key (which an operator can mend between two tries) are. Anything else is recorded as `handler_error`, without its message. The lease is checked between the steps and not inside them, so it must be longer than the work.

## What is and is not shown

Tested with GitHub and the sandbox replaced by stand-ins that record what they are asked, against a real database and the real worker loop: a request is analysed and stored once under its own organisation, each failure is recorded as its code with the tries it is allowed, nothing is held open in a transaction while it works, a run that is stored already is not stored again and one that holds other facts is refused. For the process: every refusal of the settings and every startup check, with the connections closed and no job taken when one fails; a request that goes through the key, the download, the driver and the store as configured, with the configured image, no network and the working copy removed; the configured lease on the queue; the built program refusing a bad configuration, a missing sandbox and wrong database roles by a code, without printing a value. In CI, which has a docker daemon and gVisor, the startup check runs against the real drivers and the program is started and stopped with a real sandbox.

It is **not** shown in a real sandbox with a real repository (that is the test of the whole path, the last part of step 9a), nor that the two GitHub timeouts reach the client, nor that the 60 s allowance in the lease is enough. A process that is killed while it analyses may leave a sandbox container and a working copy behind, and nothing sweeps them yet. A repository whose facts are larger than the sandbox's output ceiling fails as `analysis_output_too_large` and stores nothing, which is known and not yet mended. **No isolation claim is made** (release gate 8 has not started).

## Tests

`pnpm --filter @codemugs/analysis-worker test` (build first: some tests run `dist/main.js`). `failure.test.ts`, `analyse-job.test.ts`, `config.test.ts`, `environment.test.ts` and `preflight.test.ts` need no database. The `*.integration.test.ts` files that use a database need `CODEMUGS_TEST_DATABASE_URL` (see [`packages/storage`](../../packages/storage/README.md)), are skipped without it, and fail when CI sets `REQUIRE_DATABASE_TESTS=true` and there is none. `preflight.sandbox.integration.test.ts` and the last test of `main.integration.test.ts` need a docker daemon and `CODEMUGS_TEST_NODE_IMAGE`; they are skipped without them, and fail when CI sets `REQUIRE_DOCKER_TESTS=true` (and `REQUIRE_GVISOR_TESTS=true` for gVisor) and there is none.
