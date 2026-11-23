import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { describeDatabase, startHarness, waitFor, type Harness } from "./db-harness.js";
import { testPrivateKey, validEnvironment } from "./test-support.js";

/**
 * These run the built program as a separate process, the way an orchestrator would: with only its
 * environment, and with signals. They need `pnpm build` first.
 *
 * The last one needs a docker daemon and the image `CODEMUGS_TEST_NODE_IMAGE`. Without them it is
 * skipped, and in CI, which sets `REQUIRE_DOCKER_TESTS`, a missing daemon or image fails the run.
 */
const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));

interface Finished {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const children: ChildProcess[] = [];

/** Starts the program with exactly this environment. */
function launch(env: Record<string, string | undefined>) {
  if (!existsSync(entry)) {
    throw new Error("apps/analysis-worker/dist/main.js is missing: run pnpm build");
  }
  const clean = Object.fromEntries(
    Object.entries({ NODE_ENV: "test", ...env }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const child = spawn(process.execPath, [entry], { env: clean, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const finished = (async (): Promise<Finished> => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    clearTimeout(timeout);
    return { code, signal, stdout, stderr };
  })();
  return { child, finished, output: () => stdout + stderr, stdout: () => stdout };
}

const logLines = (stdout: string): Array<Record<string, unknown>> =>
  stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

const KEY_LINE = testPrivateKey().split("\n")[1] ?? "unreachable";

describe("the program with a configuration it cannot use", () => {
  it("exits at once and names every variable that is missing", async () => {
    const result = await launch({}).finished;
    expect(result.code).toBe(1);
    for (const name of [
      "DATABASE_URL",
      "DISPATCHER_DATABASE_URL",
      "CODEMUGS_GITHUB_APP_PRIVATE_KEY",
      "ANALYSIS_SANDBOX_DRIVER",
      "ANALYSIS_SANDBOX_MINIMUM_ISOLATION",
      "ANALYSIS_SANDBOX_IMAGE",
      "ANALYSIS_WORKSPACE_ROOT",
    ]) {
      expect(result.stderr).toContain(name);
    }
    expect(result.stdout).toBe("");
  });

  it("never echoes a rejected value, a password or the key", async () => {
    const marker = "rejected-value-marker";
    const env = validEnvironment({
      DATABASE_URL: `mysql://root:app-password-1@db.example.test/${marker}`,
      WORKER_CONCURRENCY: marker,
      ANALYSIS_SANDBOX_IMAGE: `node:${marker}`,
      CODEMUGS_GITHUB_APP_ID: marker,
    });
    const result = await launch(env).finished;
    expect(result.code).toBe(1);
    for (const name of [
      "DATABASE_URL",
      "WORKER_CONCURRENCY",
      "ANALYSIS_SANDBOX_IMAGE",
      "CODEMUGS_GITHUB_APP_ID",
    ]) {
      expect(result.stderr).toContain(name);
    }
    const text = result.stdout + result.stderr;
    expect(text).not.toContain(marker);
    expect(text).not.toContain("app-password-1");
    expect(text).not.toContain("dispatcher-password-2");
    expect(text).not.toContain(KEY_LINE);
  });

  it("refuses a lease that is shorter than an analysis can be", async () => {
    const result = await launch(validEnvironment({ WORKER_LEASE_SECONDS: "60" })).finished;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("WORKER_LEASE_SECONDS");
    expect(result.stdout).toBe("");
  });
});

describeDatabase("the program with a database", () => {
  let h: Harness;
  let scratch: string;
  let workspace: string;
  let emptyPath: string;

  beforeAll(async () => {
    h = await startHarness();
    scratch = await realpath(await mkdtemp(join(tmpdir(), "analysis-main-")));
    workspace = join(scratch, "work");
    emptyPath = join(scratch, "no-programs");
    await mkdir(workspace);
    await mkdir(emptyPath);
  }, 60_000);

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
    await h.close();
  });

  const environment = (overrides: Record<string, string | undefined> = {}) =>
    validEnvironment({
      DATABASE_URL: h.urls.app,
      DISPATCHER_DATABASE_URL: h.urls.dispatcher,
      ANALYSIS_WORKSPACE_ROOT: workspace,
      LOG_LEVEL: "debug",
      WORKER_POLL_INTERVAL_MS: "20",
      ...overrides,
    });

  it("refuses to start when there is no sandbox to run in, and says so by its code", async () => {
    // No program can be found on this path, so the docker command cannot be run.
    const result = await launch(environment({ PATH: emptyPath })).finished;
    expect(result.code).toBe(1);
    const fatal = logLines(result.stdout).find((line) => line["level"] === "fatal");
    expect(fatal).toMatchObject({
      code: "sandbox_unavailable",
      variable: "ANALYSIS_SANDBOX_DRIVER",
    });

    const text = result.stdout + result.stderr;
    expect(text).not.toContain(KEY_LINE);
    expect(text).not.toContain(decodeURIComponent(new URL(h.urls.app).password));
    expect(text).not.toContain(h.urls.app);
    expect(await readdir(workspace)).toEqual([]);
  });

  it("refuses to start when the database addresses are the wrong roles", async () => {
    const result = await launch(
      environment({ DATABASE_URL: h.urls.dispatcher, DISPATCHER_DATABASE_URL: h.urls.app }),
    ).finished;
    expect(result.code).toBe(1);
    const fatal = logLines(result.stdout).find((line) => line["level"] === "fatal");
    expect(fatal).toMatchObject({ code: "wrong_role", variable: "DATABASE_URL" });
  });
});

// The program in a real sandbox: only where there is a docker daemon and the image.
const image = process.env["CODEMUGS_TEST_NODE_IMAGE"];
const dockerRuns = ((): boolean => {
  if (image === undefined) return false;
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
})();
const dockerRequired = process.env["REQUIRE_DOCKER_TESTS"] === "true";

(dockerRuns || dockerRequired ? describeDatabase : describe.skip)(
  "the program with a docker sandbox",
  () => {
    let h: Harness;
    let scratch: string;
    let workspace: string;

    beforeAll(async () => {
      if (!dockerRuns || image === undefined) {
        throw new Error(
          "these tests are required but there is no usable docker daemon, or the image CODEMUGS_TEST_NODE_IMAGE is not on this host",
        );
      }
      h = await startHarness();
      scratch = await realpath(await mkdtemp(join(tmpdir(), "analysis-main-docker-")));
      workspace = join(scratch, "work");
      await mkdir(workspace);
    }, 60_000);

    afterAll(async () => {
      if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
      await h?.close();
    });

    const inherited = Object.fromEntries(
      ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "XDG_RUNTIME_DIR"].flatMap(
        (name) => {
          const value = process.env[name];
          return value === undefined ? [] : [[name, value]];
        },
      ),
    );

    it("checks the sandbox, starts, takes a stop request and ends by itself, with no folder left", async () => {
      const running = launch({
        ...validEnvironment({
          DATABASE_URL: h.urls.app,
          DISPATCHER_DATABASE_URL: h.urls.dispatcher,
          ANALYSIS_SANDBOX_IMAGE: image,
          ANALYSIS_WORKSPACE_ROOT: workspace,
          LOG_LEVEL: "debug",
        }),
        ...inherited,
      });
      await waitFor(
        "the process to start",
        () => running.stdout().includes("worker started") || running.child.exitCode !== null,
        30_000,
      );
      expect(running.output()).toContain("worker started");

      running.child.kill("SIGTERM");
      const result = await running.finished;
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("shutdown complete");
      const text = result.stdout + result.stderr;
      expect(text).not.toContain(KEY_LINE);
      expect(text).not.toContain(h.urls.app);
      expect(await readdir(workspace)).toEqual([]);
    }, 60_000);
  },
);
