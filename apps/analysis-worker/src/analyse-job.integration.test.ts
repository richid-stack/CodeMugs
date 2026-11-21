import { randomUUID } from "node:crypto";
import { AnalysisError } from "@codemugs/application-intelligence";
import { GitHubError } from "@codemugs/github";
import { enqueueJob, runWorker, type WorkerEvent } from "@codemugs/jobs";
import {
  ANALYSE_JOB_ATTEMPTS,
  ANALYSE_JOB_KIND,
  getAnalysis,
  requestAnalysis,
  type AnalysisState,
} from "@codemugs/repository-analysis";
import { withTenant } from "@codemugs/storage";
import { latestRun, saveAnalysis } from "@codemugs/system-graph";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { analysisHandlers, type AnalyseJobDependencies } from "./analyse-job.js";
import {
  describeDatabase,
  startHarness,
  waitFor,
  type Harness,
  type Tenant,
} from "./db-harness.js";
import { COMMIT, fakeGitHub, sampleFacts } from "./test-support.js";

describeDatabase("the job that analyses a repository, in the worker", () => {
  let h: Harness;
  let a: Tenant;
  let b: Tenant;
  const started: Array<{ controller: AbortController; done: Promise<void> }> = [];

  beforeAll(async () => {
    h = await startHarness();
    a = await h.tenant("A", 11, "acme", "shop");
    b = await h.tenant("B", 22, "other", "thing");
  }, 60_000);

  afterEach(async () => {
    for (const { controller, done } of started.splice(0)) {
      controller.abort();
      await done;
    }
  });

  afterAll(async () => {
    await h.close();
  });

  function startWorker(dependencies: AnalyseJobDependencies): { events: WorkerEvent[] } {
    const controller = new AbortController();
    const events: WorkerEvent[] = [];
    const done = runWorker({
      dispatcher: h.dispatcher,
      app: h.app,
      handlers: analysisHandlers(dependencies),
      signal: controller.signal,
      concurrency: 2,
      pollIntervalMs: 20,
      backoff: { baseSeconds: 0, maxSeconds: 0 },
      onEvent: (event) => events.push(event),
    });
    started.push({ controller, done });
    return { events };
  }

  const ask = (tenant: Tenant, ref = "main"): Promise<string> =>
    withTenant(h.app, tenant.organisationId, (client) =>
      requestAnalysis(client, { projectId: tenant.projectId, ref }),
    ).then((result) => result.requestId);
  const state = (tenant: Tenant, requestId: string): Promise<AnalysisState | undefined> =>
    withTenant(h.app, tenant.organisationId, (client) => getAnalysis(client, requestId));
  const settled = async (tenant: Tenant, requestId: string): Promise<AnalysisState> => {
    await waitFor("the analysis to end", async () => {
      const now = await state(tenant, requestId);
      return now?.status === "succeeded" || now?.status === "failed";
    });
    return (await state(tenant, requestId))!;
  };
  const job = async (requestId: string) =>
    (
      await h.admin.query<{ status: string; attempts: number; last_error_code: string | null }>(
        "SELECT status, attempts, last_error_code FROM jobs WHERE subject_id = $1",
        [requestId],
      )
    ).rows[0];
  const runCount = async (requestId: string): Promise<number> =>
    (await h.admin.query("SELECT 1 FROM analysis_runs WHERE id = $1", [requestId])).rowCount ?? 0;

  const analyseWith =
    (facts = sampleFacts()): AnalyseJobDependencies["analyse"] =>
    async (archive) => {
      await archive(() => Promise.resolve());
      return facts;
    };

  it("analyses the repository of a request and stores the graph under the request's id", async () => {
    const github = fakeGitHub();
    startWorker({ openRepository: github.openRepository, analyse: analyseWith() });
    const requestId = await ask(a, "release/1");
    const result = await settled(a, requestId);

    expect(result).toMatchObject({
      status: "succeeded",
      attempts: 1,
      run: { revision: COMMIT, truncated: [] },
    });
    expect(result.run?.nodes).toBeGreaterThan(0);
    expect(github.calls.opened).toEqual([{ installationId: 11, name: "shop" }]);
    expect(github.calls.commitIds).toEqual([{ owner: "acme", name: "shop", ref: "release/1" }]);
    expect(github.calls.downloads.map((download) => download.ref)).toEqual([COMMIT]);
    expect(await job(requestId)).toMatchObject({ status: "succeeded", attempts: 1 });

    const stored = await h.admin.query(
      "SELECT organisation_id, project_id, revision FROM analysis_runs WHERE id = $1",
      [requestId],
    );
    expect(stored.rows).toEqual([
      { organisation_id: a.organisationId, project_id: a.projectId, revision: COMMIT },
    ]);
    const latest = await withTenant(h.app, a.organisationId, (client) =>
      latestRun(client, a.projectId),
    );
    expect(latest?.id).toBe(requestId);
  });

  it("analyses each organisation's request with its own repository, and stores it as that organisation's", async () => {
    const github = fakeGitHub();
    startWorker({ openRepository: github.openRepository, analyse: analyseWith() });
    const [first, second] = [await ask(a), await ask(b)];
    await settled(a, first);
    await settled(b, second);

    expect(github.calls.opened).toEqual(
      expect.arrayContaining([
        { installationId: 11, name: "shop" },
        { installationId: 22, name: "thing" },
      ]),
    );
    expect(github.calls.commitIds).toEqual(
      expect.arrayContaining([
        { owner: "acme", name: "shop", ref: "main" },
        { owner: "other", name: "thing", ref: "main" },
      ]),
    );
    const stored = await h.admin.query<{ id: string; organisation_id: string }>(
      "SELECT id, organisation_id FROM analysis_runs WHERE id = ANY($1)",
      [[first, second]],
    );
    expect(Object.fromEntries(stored.rows.map((row) => [row.id, row.organisation_id]))).toEqual({
      [first]: a.organisationId,
      [second]: b.organisationId,
    });
    expect(await state(b, first)).toBeUndefined();
    expect(await state(a, second)).toBeUndefined();
  });

  it("holds no transaction open while it downloads and analyses", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let inside = false;
    const github = fakeGitHub();
    startWorker({
      openRepository: github.openRepository,
      analyse: async (archive) => {
        await archive(() => Promise.resolve());
        inside = true;
        await gate;
        return sampleFacts();
      },
    });
    const requestId = await ask(a);
    await waitFor("the analysis to be under way", () => inside);
    // Longer than a handler that held its transaction would survive on a database with the 30 s limit
    // is not needed: what matters is that none is open at all.
    const idle = await h.admin.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'",
    );
    expect(idle.rowCount).toBe(0);
    expect((await state(a, requestId))?.status).toBe("running");
    open();
    expect((await settled(a, requestId)).status).toBe("succeeded");
  });

  describe("when it cannot be done", () => {
    it("records a failure that another try cannot mend, once, with its code", async () => {
      const github = fakeGitHub({
        getCommitId: () => Promise.reject(new GitHubError("request_failed", 404)),
      });
      startWorker({ openRepository: github.openRepository, analyse: analyseWith() });
      const requestId = await ask(a, "no-such-branch");
      const result = await settled(a, requestId);
      expect(result).toMatchObject({
        status: "failed",
        attempts: 1,
        failureCode: "repository_or_ref_not_found",
      });
      expect(await job(requestId)).toMatchObject({
        status: "dead",
        attempts: 1,
        last_error_code: "repository_or_ref_not_found",
      });
      expect(await runCount(requestId)).toBe(0);
    });

    it("tries a failure that another try can mend again, and stores the graph once", async () => {
      let asked = 0;
      const github = fakeGitHub({
        getCommitId: () => {
          asked += 1;
          return asked === 1
            ? Promise.reject(new GitHubError("request_failed", 503))
            : Promise.resolve(COMMIT);
        },
      });
      startWorker({ openRepository: github.openRepository, analyse: analyseWith() });
      const requestId = await ask(a);
      const result = await settled(a, requestId);
      expect(result).toMatchObject({ status: "succeeded", attempts: 2 });
      expect(await runCount(requestId)).toBe(1);
    });

    it("gives up when the tries that the request allowed are used", async () => {
      const github = fakeGitHub({
        getCommitId: () => Promise.reject(new GitHubError("timed_out")),
      });
      startWorker({ openRepository: github.openRepository, analyse: analyseWith() });
      const requestId = await ask(a);
      const result = await settled(a, requestId);
      expect(result).toMatchObject({
        status: "failed",
        attempts: ANALYSE_JOB_ATTEMPTS,
        failureCode: "github_unavailable",
      });
      expect(await runCount(requestId)).toBe(0);
    });

    it("records what the sandbox could not do by its code", async () => {
      const github = fakeGitHub();
      startWorker({
        openRepository: github.openRepository,
        analyse: () => Promise.reject(new AnalysisError("analysis_out_of_memory")),
      });
      const requestId = await ask(a);
      expect(await settled(a, requestId)).toMatchObject({
        status: "failed",
        attempts: 1,
        failureCode: "analysis_out_of_memory",
      });
    });

    it("records anything unexpected as handler_error, and keeps its message out of the data", async () => {
      const github = fakeGitHub();
      startWorker({
        openRepository: github.openRepository,
        analyse: () => Promise.reject(new Error("could not read /srv/customer/secret.env")),
      });
      const requestId = await ask(a);
      const result = await settled(a, requestId);
      expect(result.failureCode).toBe("handler_error");
      expect(JSON.stringify(result)).not.toContain("secret");
      const row = await h.admin.query("SELECT * FROM jobs WHERE subject_id = $1", [requestId]);
      expect(JSON.stringify(row.rows)).not.toContain("secret");
    });

    it("fails a job that has no request at once", async () => {
      startWorker({ openRepository: fakeGitHub().openRepository, analyse: analyseWith() });
      const subjectId = randomUUID();
      await withTenant(h.app, a.organisationId, (client) =>
        enqueueJob(client, { kind: ANALYSE_JOB_KIND, subjectId, maxAttempts: 3 }),
      );
      await waitFor("the job to end", async () => (await job(subjectId))?.status === "dead");
      expect(await job(subjectId)).toMatchObject({
        attempts: 1,
        last_error_code: "request_not_found",
      });
    });
  });

  describe("when the run is stored already", () => {
    const store = (requestId: string, facts = sampleFacts()) =>
      withTenant(h.app, a.organisationId, (client) =>
        saveAnalysis(client, { runId: requestId, projectId: a.projectId, revision: COMMIT, facts }),
      );

    it("completes the job and keeps the one run, when it is the same analysis", async () => {
      const requestId = await ask(a);
      // Before a worker is there to take the job.
      await store(requestId);
      startWorker({ openRepository: fakeGitHub().openRepository, analyse: analyseWith() });
      await waitFor(
        "the job to finish",
        async () => (await job(requestId))?.status === "succeeded",
      );
      expect(await runCount(requestId)).toBe(1);
    });

    it("refuses another analysis under the same id, and does not try again", async () => {
      const requestId = await ask(a);
      await store(requestId, sampleFacts({ files: ["src/other.ts"] }));
      startWorker({ openRepository: fakeGitHub().openRepository, analyse: analyseWith() });
      await waitFor("the job to end", async () => (await job(requestId))?.status === "dead");
      expect(await job(requestId)).toMatchObject({
        attempts: 1,
        last_error_code: "graph_run_conflict",
      });
      expect(await runCount(requestId)).toBe(1);
    });
  });
});
