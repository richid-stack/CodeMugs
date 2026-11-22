# repository-analysis

**Status:** In progress · Phase 2 Understanding. Step 9a, second part: which repository a project is, a request to analyse it, and how the request is going. It is tested and the API calls it ([ADR 0034](../../docs/architecture/decisions/0034-analysis-routes.md)), but **nothing runs the job yet**: the process for the worker (`apps/analysis-worker`) is the next part, and the application cannot delete any of this yet (release gate 15), so it must not be switched on for a real customer. Decision: [ADR 0031](../../docs/architecture/decisions/0031-connecting-a-repository-and-asking-for-an-analysis.md).

This is the side of the analysis that the **API** uses. It reads and writes rows and enqueues a job. It holds no GitHub credential, reads no repository and runs nothing; the job is done by a worker of its own ([ADR 0014](../../docs/architecture/decisions/0014-worker-process.md), [ADR 0029](../../docs/architecture/decisions/0029-connecting-an-archive-to-the-analysis.md)). Everything runs in a `withTenant` transaction, so the organisation is the credential's and is taken from no argument (invariant 1).

## Interface

```ts
import {
  connectRepository,
  getConnection,
  requestAnalysis,
  readAnalysisPlan,
  getAnalysis,
  listAnalyses,
  RepositoryAnalysisError,
  ANALYSE_JOB_KIND,
} from "@codemugs/repository-analysis";
```

- `connectRepository(client, { projectId, installationId, owner, name })`: says that a project is a repository on GitHub. The installation has to be one that an operator has bound to the organisation; a number that is not, whether nobody has it or another organisation does, is `installation_not_found` in both cases. A project has one repository (`connection_exists`). It does not look at GitHub: whether the installation can read the repository is found out, and said, when it is analysed.
- `getConnection(client, projectId)`: the repository of a project, or `undefined`.
- `requestAnalysis(client, { projectId, ref })`: writes a request and the job that does it in the caller's transaction, and returns the request's id, which is also the job's subject and, once it is done, the run's id. A ref is a branch, a tag or a commit with no space or control character, up to 255 characters; whether it exists is the worker's to say. Asking twice is two requests.
- `readAnalysisPlan(client, requestId)`: what the worker needs (which repository, which ref, which installation), or `undefined`.
- `getAnalysis(client, requestId)` and `listAnalyses(client, projectId, { limit? })` (1 to 100, 20 by default, newest first): how it is going. The status is **read from the job and from the stored run**, never stored: `queued`, `running`, `retrying` (with the failure's code), `succeeded` (with the run's revision, node and edge counts and what was cut), `failed` (with the code) and `unknown` (the job finished or is gone and no run was stored).
- Errors are `RepositoryAnalysisError` with a code (`invalid_input`, `project_not_found`, `installation_not_found`, `connection_exists`, `connection_not_found`) and a fixed sentence that says nothing of what was given. A bad argument is refused before the database is asked.

The tables are `github_installations`, `repository_connections` and `analysis_requests` ([migration 0008](../../packages/storage/migrations/0008_repository_analysis.sql)). The application can read `github_installations` and cannot write it (an operator does), and can insert and read the other two and cannot update or delete them.

## What is and is not shown

Tested locally against PostgreSQL 16 (CI runs 17 and 18): a tenant cannot read, write or point into another tenant's rows, an installation cannot be bound to two organisations or named by a tenant that does not have it, a request and its job exist together or not at all, and the status of each state is read correctly. It is **not** shown that a tenant that can run its own SQL as the application role cannot reach another's rows, and nothing here is evidence for a release gate. There is no flow that binds an installation yet (an operator inserts the row), and no way to change a project's repository.

## Tests

`pnpm --filter @codemugs/repository-analysis test`. `input.test.ts` needs no database. The rest need `CODEMUGS_TEST_DATABASE_URL` (see [`packages/storage`](../../packages/storage/README.md)) and are skipped without it; CI sets `REQUIRE_DATABASE_TESTS=true` to turn a missing database into a failure.
