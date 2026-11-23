import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tarball } from "@codemugs/archive/testing";
import { WorkerStartupError } from "@codemugs/jobs";
import { createLogger } from "@codemugs/logging";
import { getAnalysis, requestAnalysis, type AnalysisState } from "@codemugs/repository-analysis";
import {
  SandboxError,
  type SandboxDriver,
  type SandboxResult,
  type SandboxRunRequest,
} from "@codemugs/sandbox-manager";
import { withTenant } from "@codemugs/storage";
import { APP_ROLE, DISPATCHER_ROLE } from "@codemugs/storage/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadAnalysisWorkerConfig } from "./config.js";
import {
  describeDatabase,
  startHarness,
  waitFor,
  type Harness,
  type Tenant,
} from "./db-harness.js";
import { verifyAnalysisDatabase, type AnalysisStartupCode } from "./preflight.js";
import { APPLICATION_NAME, startAnalysisWorker, type WorkerHandle } from "./start.js";
import {
  COMMIT,
  fakeGitHub,
  sampleFacts,
  testPrivateKey,
  validEnvironment,
} from "./test-support.js";

const IMAGE = `docker.io/library/node@sha256:${"c".repeat(64)}`;
const READY = "codemugs-sandbox-ready";

const exited = (stdout: string, overrides: Partial<SandboxResult> = {}): SandboxResult => ({
  outcome: "exited",
  exitCode: 0,
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 5,
  ...overrides,
});

/** A sandbox that runs nothing: it answers the startup check, and an analysis with sample facts. */
function standInSandbox(overrides: { available?: boolean } = {}) {
  const requests: SandboxRunRequest[] = [];
  const driver: SandboxDriver = {
    name: "stand-in",
    isolation: "hardened-container",
    availability: () =>
      Promise.resolve(
        overrides.available === false
          ? { available: false, reason: "no daemon here" }
          : { available: true },
      ),
    run: (request) => {
      requests.push(request);
      if (request.command.join(" ").includes(READY)) return Promise.resolve(exited(READY));
      return Promise.resolve(exited(JSON.stringify(sampleFacts())));
    },
  };
  return { driver, requests };
}

describeDatabase("the process that analyses repositories", () => {
  let h: Harness;
  let tenant: Tenant;
  let workspace: string;
  let scratch: string;
  const running: WorkerHandle[] = [];
  let lines: string[];

  beforeAll(async () => {
    h = await startHarness();
    tenant = await h.tenant("A", 11, "acme", "shop");
    scratch = await realpath(await mkdtemp(join(tmpdir(), "analysis-start-")));
    workspace = join(scratch, "work");
    await mkdir(workspace);
  }, 60_000);

  afterEach(async () => {
    for (const handle of running.splice(0)) await handle.stop().catch(() => undefined);
    await h.admin.query("DELETE FROM jobs");
    lines = [];
  });
  lines = [];

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
    await h.close();
  });

  const config = (overrides: Record<string, string | undefined> = {}) =>
    loadAnalysisWorkerConfig(
      validEnvironment({
        DATABASE_URL: h.urls.app,
        DISPATCHER_DATABASE_URL: h.urls.dispatcher,
        ANALYSIS_SANDBOX_IMAGE: IMAGE,
        ANALYSIS_WORKSPACE_ROOT: workspace,
        WORKER_POLL_INTERVAL_MS: "20",
        ...overrides,
      }),
    );

  async function start(
    options: Partial<Parameters<typeof startAnalysisWorker>[0]> = {},
  ): Promise<WorkerHandle> {
    const handle = await startAnalysisWorker({
      config: config(),
      logger: createLogger("debug", (line) => lines.push(line)),
      ...options,
    });
    running.push(handle);
    return handle;
  }

  /** Connections that the server holds for this process in this test's database. */
  async function openConnections(): Promise<number> {
    const result = await h.admin.query<{ count: string }>(
      "SELECT count(*) FROM pg_stat_activity WHERE datname = $1 AND application_name = $2",
      [h.databaseName, APPLICATION_NAME],
    );
    return Number(result.rows[0]?.count);
  }

  const noConnections = (): Promise<void> =>
    waitFor("the connections to close", async () => (await openConnections()) === 0);

  const failureOf = async (
    work: Promise<unknown>,
  ): Promise<WorkerStartupError<AnalysisStartupCode>> => {
    try {
      await work;
    } catch (error) {
      if (error instanceof WorkerStartupError) {
        return error as WorkerStartupError<AnalysisStartupCode>;
      }
      throw error;
    }
    throw new Error("the process started");
  };

  describe("the checks of the database", () => {
    it("passes for the two roles on a migrated database", async () => {
      await expect(
        verifyAnalysisDatabase({ app: h.app, dispatcher: h.dispatcher }),
      ).resolves.toBeUndefined();
    });

    it("refuses the application role as the dispatcher, which would see no jobs", async () => {
      const error = await failureOf(verifyAnalysisDatabase({ app: h.app, dispatcher: h.app }));
      expect(error).toMatchObject({ code: "wrong_role", variable: "DISPATCHER_DATABASE_URL" });
    });

    it.each([
      "jobs",
      "analysis_requests",
      "repository_connections",
      "analysis_runs",
      "graph_nodes",
      "graph_edges",
    ])("refuses an application role that may not read %s", async (table) => {
      await h.admin.query(`REVOKE SELECT ON ${table} FROM ${APP_ROLE}`);
      try {
        const error = await failureOf(
          verifyAnalysisDatabase({ app: h.app, dispatcher: h.dispatcher }),
        );
        expect(error).toMatchObject({ code: "schema_not_ready", variable: "DATABASE_URL" });
      } finally {
        await h.admin.query(`GRANT SELECT ON ${table} TO ${APP_ROLE}`);
      }
      await expect(
        verifyAnalysisDatabase({ app: h.app, dispatcher: h.dispatcher }),
      ).resolves.toBeUndefined();
    });

    it("refuses a dispatcher role that may not read the jobs", async () => {
      await h.admin.query(`REVOKE SELECT ON jobs FROM ${DISPATCHER_ROLE}`);
      try {
        const error = await failureOf(
          verifyAnalysisDatabase({ app: h.app, dispatcher: h.dispatcher }),
        );
        expect(error).toMatchObject({
          code: "schema_not_ready",
          variable: "DISPATCHER_DATABASE_URL",
        });
      } finally {
        await h.admin.query(`GRANT SELECT ON jobs TO ${DISPATCHER_ROLE}`);
      }
    });
  });

  describe("starting", () => {
    it("starts, says what it was told, and keeps every secret out of what it says", async () => {
      const { driver } = standInSandbox();
      await start({ driver, openRepository: fakeGitHub().openRepository });

      const started = lines.find((line) => line.includes("worker started"));
      expect(started).toBeDefined();
      const record = JSON.parse(started ?? "{}") as Record<string, unknown>;
      expect(record).toMatchObject({
        kinds: "repository.analyse",
        concurrency: 1,
        leaseSeconds: 600,
        sandbox: "stand-in",
        isolation: "hardened-container",
        minimumIsolation: "hardened-container",
      });

      const text = lines.join("\n");
      expect(text).not.toContain("BEGIN");
      expect(text).not.toContain(testPrivateKey().split("\n")[1] ?? "unreachable");
      expect(text).not.toContain(h.urls.app);
      expect(text).not.toContain(decodeURIComponent(new URL(h.urls.app).password));
    });

    it("leaves no folder of the startup check behind", async () => {
      await start({ driver: standInSandbox().driver, openRepository: fakeGitHub().openRepository });
      expect(await readdir(workspace)).toEqual([]);
    });

    it("closes every connection when it is stopped", async () => {
      const handle = await start({
        driver: standInSandbox().driver,
        openRepository: fakeGitHub().openRepository,
      });
      await waitFor("a connection", async () => (await openConnections()) > 0);
      await handle.stop();
      await noConnections();
    });

    it("is refused, and takes no job, when the sandbox cannot run", async () => {
      await withTenant(h.app, tenant.organisationId, (client) =>
        requestAnalysis(client, { projectId: tenant.projectId, ref: "main" }),
      );
      const { driver, requests } = standInSandbox({ available: false });
      const github = fakeGitHub();
      const error = await failureOf(start({ driver, openRepository: github.openRepository }));
      expect(error).toMatchObject({
        code: "sandbox_unavailable",
        variable: "ANALYSIS_SANDBOX_DRIVER",
      });
      expect(requests).toHaveLength(0);
      expect(github.calls.opened).toHaveLength(0);
      await noConnections();
      const job = await h.admin.query<{ status: string }>("SELECT status FROM jobs");
      expect(job.rows.map((row) => row.status)).toEqual(["queued"]);
    });

    it("is refused when the sandbox is weaker than the configuration asks for", async () => {
      const weaker = config({
        ANALYSIS_SANDBOX_DRIVER: "gvisor",
        ANALYSIS_SANDBOX_MINIMUM_ISOLATION: "gvisor",
      });
      const error = await failureOf(start({ config: weaker, driver: standInSandbox().driver }));
      expect(error).toMatchObject({
        code: "sandbox_too_weak",
        variable: "ANALYSIS_SANDBOX_MINIMUM_ISOLATION",
      });
      await noConnections();
    });

    it("is refused when the dispatcher address is really a superuser's, with the connections closed", async () => {
      const error = await failureOf(
        start({
          config: config({ DISPATCHER_DATABASE_URL: h.urls.admin }),
          driver: standInSandbox().driver,
        }),
      );
      expect(error).toMatchObject({ code: "wrong_role", variable: "DISPATCHER_DATABASE_URL" });
      expect(error.message).not.toContain(decodeURIComponent(new URL(h.urls.admin).password));
      await noConnections();
    });

    it("is refused when the key cannot sign, before it connects to anything", async () => {
      const ecKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      let asked = 0;
      const error = await failureOf(
        start({
          config: config({ CODEMUGS_GITHUB_APP_PRIVATE_KEY: ecKey }),
          driver: standInSandbox().driver,
          verifyDatabase: () => {
            asked += 1;
            return Promise.resolve();
          },
        }),
      );
      expect(error).toMatchObject({
        code: "github_key_unusable",
        variable: "CODEMUGS_GITHUB_APP_PRIVATE_KEY",
      });
      expect(asked).toBe(0);
      expect(await openConnections()).toBe(0);
    });
  });

  describe("a request that is analysed", () => {
    const stateOf = (id: string): Promise<AnalysisState | undefined> =>
      withTenant(h.app, tenant.organisationId, (client) => getAnalysis(client, id), {
        readOnly: true,
      });

    /** A GitHub that gives a real archive of one file, as the download does. */
    const githubWithArchive = () => {
      const archive = tarball([
        { name: "acme-shop-0123456/src/a.ts", content: "export const a = 1;" },
      ]);
      return fakeGitHub({
        downloadTarball: async (_owner, _name, _ref, options) => {
          await options.onChunk?.(new Uint8Array(archive));
          return { bytes: archive.length, sha256: "0".repeat(64) };
        },
      });
    };

    it("goes through the key, the download, the sandbox and the store, as configured", async () => {
      const { driver, requests } = standInSandbox();
      const github = githubWithArchive();
      await start({ driver, openRepository: github.openRepository });

      const { requestId } = await withTenant(h.app, tenant.organisationId, (client) =>
        requestAnalysis(client, { projectId: tenant.projectId, ref: "main" }),
      );
      await waitFor("the analysis to succeed", async () => {
        return (await stateOf(requestId))?.status === "succeeded";
      });

      const state = await stateOf(requestId);
      expect(state?.run?.revision).toBe(COMMIT);
      // The installation and the repository are the request's, from the database.
      expect(github.calls.opened).toEqual([{ installationId: 11, name: "shop" }]);

      // What the sandbox was asked for is what the configuration says, and nothing else.
      const analysis = requests.filter((request) => !request.command.join(" ").includes(READY));
      expect(analysis).toHaveLength(1);
      expect(analysis[0]?.policy.image).toBe(IMAGE);
      expect(analysis[0]?.policy.network).toEqual({ mode: "none" });
      expect(analysis[0]?.sourceDirectory?.startsWith(`${workspace}/`)).toBe(true);

      // The working copy of the repository is gone.
      expect(await readdir(workspace)).toEqual([]);
    });

    it("holds the job for as long as the configured lease says while it is analysed", async () => {
      let open: () => void = () => undefined;
      const wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      const { driver } = standInSandbox();
      const slow: SandboxDriver = {
        ...driver,
        run: async (request) => {
          if (!request.command.join(" ").includes(READY)) await wait;
          return driver.run(request);
        },
      };
      await start({
        config: config({ WORKER_LEASE_SECONDS: "777" }),
        driver: slow,
        openRepository: githubWithArchive().openRepository,
      });
      const { requestId } = await withTenant(h.app, tenant.organisationId, (client) =>
        requestAnalysis(client, { projectId: tenant.projectId, ref: "main" }),
      );
      await waitFor("the job to be running", async () => {
        const rows = await h.admin.query("SELECT 1 FROM jobs WHERE status = 'running'");
        return rows.rows.length === 1;
      });
      // A running job's `available_at` is when its lease runs out.
      const lease = await h.admin.query<{ seconds: number }>(
        "SELECT EXTRACT(EPOCH FROM (available_at - now()))::float8 AS seconds FROM jobs WHERE status = 'running'",
      );
      const seconds = lease.rows[0]?.seconds ?? 0;
      expect(seconds).toBeGreaterThan(700);
      expect(seconds).toBeLessThanOrEqual(777);

      open();
      await waitFor("the analysis to succeed", async () => {
        return (await stateOf(requestId))?.status === "succeeded";
      });
    });

    it("refuses to analyse, and says so by a code, when the sandbox stops being there", async () => {
      let available = true;
      const { driver } = standInSandbox();
      const flaky: SandboxDriver = {
        ...driver,
        availability: () =>
          Promise.resolve(available ? { available: true } : { available: false, reason: "gone" }),
        run: (request) => {
          if (!available) return Promise.reject(new SandboxError("unavailable"));
          return driver.run(request);
        },
      };
      await start({ driver: flaky, openRepository: fakeGitHub().openRepository });
      available = false;

      const { requestId } = await withTenant(h.app, tenant.organisationId, (client) =>
        requestAnalysis(client, { projectId: tenant.projectId, ref: "main" }),
      );
      // The count of tries goes up when the job is taken and the code is written when the try fails,
      // so it is the code that says the first try is over.
      await waitFor("the first try to fail", async () => {
        return (await stateOf(requestId))?.failureCode !== undefined;
      });
      const state = await stateOf(requestId);
      expect(state?.status).not.toBe("succeeded");
      expect(state?.failureCode).toBe("sandbox_unavailable");
    });
  });
});
