# @codemugs/analysis-worker

The job that analyses a repository: it takes a request that [`@codemugs/repository-analysis`](../../core/repository-analysis/README.md) recorded, finds the commit, downloads it, has it analysed in the sandbox and stores the graph.

**Status:** In progress · Phase 2 Understanding, step 9a, third part. **The job exists and is tested; the process that runs it does not.** There is no `main`, no configuration for the GitHub App's key or the sandbox, no startup checks, no container image and no deployment, so nothing analyses a repository yet. That is the next part. Decisions: [ADR 0032](../../docs/architecture/decisions/0032-the-job-that-analyses-a-repository.md), [ADR 0031](../../docs/architecture/decisions/0031-connecting-a-repository-and-asking-for-an-analysis.md), [ADR 0014](../../docs/architecture/decisions/0014-worker-process.md).

It is a package of its own, and not part of `apps/worker`, because `apps/worker` never reads repository contents (ADR 0014) and the API must hold nothing that can reach GitHub (ADR 0031). It is the one place that holds, through what it is given, a key for GitHub and a way to the sandbox.

## What the job does

`analyseJob(dependencies)` is a job that takes long ([ADR 0030](../../docs/architecture/decisions/0030-long-jobs.md)): no transaction is open while it works, and the graph is stored in the transaction that completes the job.

1. Reads the request's plan (installation, repository, ref) in the job's organisation. No such request: `request_not_found`, not tried again.
2. Opens a reader for that one repository (a token narrowed to it and to read access) and asks GitHub for the commit that the ref names now.
3. Downloads **that commit**, not the ref, and has it analysed. What it holds is untrusted data and nothing of it runs here (invariants 2 and 8).
4. Stores the run under the request's id, with the commit as its revision. The id is the key that makes a repeat harmless, so a job that runs twice stores one run.

What it needs is given to it: `openRepository` (`githubRepositories(app)` is the one that asks GitHub), `analyse` (the sandbox, its image and how much it must isolate are the process's to say) and, if it is to be smaller than the unpacking's limit, `maxArchiveBytes`. `analysisHandlers(dependencies)` gives the handler for `repository.analyse`.

## How it fails

A failure is a short code and whether another try could do better; what GitHub, the sandbox or the database said is never kept (ADR 0012). `failureOf` is the table, and it is tested row by row. Not found, a download or output that is too large, a sandbox that is too weak, a timeout, an analyser fault and a refused run are not tried again; GitHub not answering, a refusal that may be a rate limit, a sandbox that failed and a bad key (which an operator can mend between two tries) are. Anything else is recorded as `handler_error`, without its message. The lease is checked between the steps and not inside them, so it must be longer than the work.

## What is and is not shown

Tested with GitHub and the sandbox replaced by stand-ins that record what they are asked, against a real database and the real worker loop: a request is analysed and stored once under its own organisation, each failure is recorded as its code with the tries it is allowed, nothing is held open in a transaction while it works, a run that is stored already is not stored again and one that holds other facts is refused. It is **not** shown against GitHub or in the sandbox (those are tested where they are, [ADR 0027](../../docs/architecture/decisions/0027-github-app-read-only.md) and [ADR 0029](../../docs/architecture/decisions/0029-connecting-an-archive-to-the-analysis.md)), nor that the pieces work together: the test of the whole path is the last part of step 9a. A repository whose facts are larger than the sandbox's output ceiling fails as `analysis_output_too_large` and stores nothing, which is known and not yet mended.

## Tests

`pnpm --filter @codemugs/analysis-worker test`. `failure.test.ts` and `analyse-job.test.ts` need no database; `analyse-job.integration.test.ts` needs `CODEMUGS_TEST_DATABASE_URL` (see [`packages/storage`](../../packages/storage/README.md)), is skipped without it, and fails when CI sets `REQUIRE_DATABASE_TESTS=true` and there is none.
