import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createOrganisation, createProject, issueApiKey } from "@codemugs/auth";
import { EVENTS_AGGREGATE_KIND, recordEvents, type IngestScope } from "@codemugs/ingestion";
import { createPool, type Pool } from "@codemugs/storage";
import { adminDatabaseUrl, createTestDatabase, type TestDatabase } from "@codemugs/storage/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * These run the built program as a separate process, the way an orchestrator would: with only its
 * environment, and with signals. They need `pnpm build` first.
 */
const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const describeDatabase = adminDatabaseUrl() === undefined ? describe.skip : describe;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Finished {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const children: ChildProcess[] = [];

/** Starts the program with exactly this environment. */
function launch(env: Record<string, string>) {
  if (!existsSync(entry)) throw new Error("apps/worker/dist/main.js is missing: run pnpm build");
  const child = spawn(process.execPath, [entry], {
    env: { NODE_ENV: "test", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const finished = (async (): Promise<Finished> => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
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

describe("the program with a configuration it cannot use", () => {
  const hidden = "pw-that-must-stay-hidden";
  const good = `postgres://codemugs_app:${hidden}@db.example.test:5432/codemugs`;
  const other = `postgres://codemugs_dispatcher:${hidden}@db.example.test:5432/codemugs`;

  it("exits at once and names both missing connections", async () => {
    const result = await launch({}).finished;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL");
    expect(result.stderr).toContain("DISPATCHER_DATABASE_URL");
    expect(result.stdout).toBe("");
  });

  it("never echoes a rejected value or a password", async () => {
    const marker = "rejected-value-marker";
    const result = await launch({
      DATABASE_URL: `mysql://root:${hidden}@db.example.test/${marker}`,
      DISPATCHER_DATABASE_URL: other,
      WORKER_CONCURRENCY: marker,
    }).finished;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL");
    expect(result.stderr).toContain("WORKER_CONCURRENCY");
    expect(result.stdout + result.stderr).not.toContain(marker);
    expect(result.stdout + result.stderr).not.toContain(hidden);
  });

  it("refuses the same connection for both roles", async () => {
    const result = await launch({ DATABASE_URL: good, DISPATCHER_DATABASE_URL: good }).finished;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DISPATCHER_DATABASE_URL");
    expect(result.stdout + result.stderr).not.toContain(hidden);
  });
});

describeDatabase("the program with a database", () => {
  let database: TestDatabase;
  let app: Pool;
  let admin: Pool;
  let orgId: string;
  let password: string;

  const environment = (overrides: Record<string, string> = {}): Record<string, string> => ({
    DATABASE_URL: database.appUrl,
    DISPATCHER_DATABASE_URL: database.dispatcherUrl,
    LOG_LEVEL: "debug",
    WORKER_POLL_INTERVAL_MS: "20",
    WORKER_CONCURRENCY: "2",
    ...overrides,
  });

  async function ingestOne(marker: string): Promise<IngestScope> {
    const project = await createProject(app, orgId, {
      name: `p-${randomUUID().slice(0, 8)}`,
      actor: { type: "system" },
    });
    const key = await issueApiKey(app, orgId, project.id, {
      name: "k",
      actor: { type: "system" },
    });
    const scope = { organisationId: orgId, projectId: project.id, apiKeyId: key.id };
    const outcome = await recordEvents(app, scope, {
      events: [
        {
          schemaVersion: 1,
          eventId: randomUUID(),
          type: "checkout.completed",
          occurredAt: "2026-03-01T10:15:00Z",
          environment: "production",
          sdk: { name: "sdk-js", version: "1.2.3" },
          attributes: { orderId: marker },
        },
      ],
    });
    if (!outcome.ok) throw new Error("the events were not stored");
    return scope;
  }

  async function waitFor(what: string, condition: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(25);
    }
  }

  const jobStatus = async (projectId: string): Promise<string | undefined> => {
    // The job's subject is the batch the project's event arrived in.
    const result = await admin.query<{ status: string }>(
      `SELECT j.status FROM jobs j
         JOIN events e ON e.organisation_id = j.organisation_id AND e.batch_id = j.subject_id
        WHERE j.organisation_id = $1 AND j.kind = $2 AND e.project_id = $3`,
      [orgId, EVENTS_AGGREGATE_KIND, projectId],
    );
    return result.rows[0]?.status;
  };

  const countOf = async (projectId: string): Promise<number> => {
    const result = await admin.query<{ event_count: string }>(
      "SELECT event_count FROM event_aggregates WHERE organisation_id = $1 AND project_id = $2",
      [orgId, projectId],
    );
    return Number(result.rows[0]?.event_count ?? 0);
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    app = createPool({ connectionString: database.appUrl, maxConnections: 4 });
    admin = createPool({ connectionString: database.adminUrl, maxConnections: 4 });
    orgId = (await createOrganisation(app, { name: "A" })).id;
    password = decodeURIComponent(new URL(database.appUrl).password);
  }, 60_000);

  afterAll(async () => {
    await app.end();
    await admin.end();
    await database.drop();
  });

  it("processes events, and stops cleanly when told to", async () => {
    const marker = `marker-${randomUUID()}`;
    const scope = await ingestOne(marker);
    const program = launch(environment());

    await waitFor(
      "the job to succeed",
      async () => (await jobStatus(scope.projectId)) === "succeeded",
    );
    expect(await countOf(scope.projectId)).toBe(1);

    program.child.kill("SIGTERM");
    const result = await program.finished;
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();

    const lines = logLines(result.stdout);
    const messages = lines.map((line) => line["msg"]);
    for (const expected of [
      "worker started",
      "job succeeded",
      "shutdown requested",
      "shutdown complete",
    ]) {
      expect(messages).toContain(expected);
    }
    expect(lines.find((line) => line["msg"] === "job succeeded")).toMatchObject({
      organisationId: orgId,
      kind: EVENTS_AGGREGATE_KIND,
      attempt: 1,
    });
    expect(result.stdout + result.stderr).not.toContain(marker);
    expect(result.stdout + result.stderr).not.toContain(password);
  });

  it("stops on SIGINT too", async () => {
    const program = launch(environment());
    await waitFor("the worker to start", () =>
      Promise.resolve(program.stdout().includes("worker started")),
    );
    program.child.kill("SIGINT");
    const result = await program.finished;
    expect(result.code).toBe(0);
  });

  it("stops cleanly when told to while it is still starting", async () => {
    // The signal is sent the moment the program says it is starting, so that it arrives while the
    // worker is still connecting. It used to end the program by the default action then, because
    // the handlers were put in only after the worker had started.
    const program = launch(environment());
    program.child.stdout?.on("data", function onData(chunk: Buffer) {
      if (!chunk.toString().includes("worker starting")) return;
      program.child.stdout?.off("data", onData);
      program.child.kill("SIGTERM");
    });
    const result = await program.finished;
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    const messages = logLines(result.stdout).map((line) => line["msg"]);
    expect(messages).toContain("shutdown requested");
    expect(messages).toContain("shutdown complete");
  });

  it("does not start with the two connections the wrong way round", async () => {
    const result = await launch(
      environment({
        DATABASE_URL: database.dispatcherUrl,
        DISPATCHER_DATABASE_URL: database.appUrl,
      }),
    ).finished;
    expect(result.code).toBe(1);
    const fatal = logLines(result.stdout).at(-1);
    expect(fatal).toMatchObject({
      level: "fatal",
      code: "wrong_role",
      variable: "DATABASE_URL",
    });
    expect(result.stdout + result.stderr).not.toContain(password);
  });

  it("does not start when the database cannot be reached, and does not say where it tried", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    server.close();
    await once(server, "close");
    if (address === null || typeof address === "string") throw new Error("no port");
    const url = new URL(database.appUrl);
    url.hostname = "127.0.0.1";
    url.port = String(address.port);

    const result = await launch(environment({ DATABASE_URL: url.toString() })).finished;
    expect(result.code).toBe(1);
    expect(logLines(result.stdout).at(-1)).toMatchObject({
      level: "fatal",
      code: "database_unreachable",
      variable: "DATABASE_URL",
    });
    expect(result.stdout + result.stderr).not.toContain(password);
    expect(result.stdout + result.stderr).not.toContain(String(address.port));
  });

  it("finishes the job it is working on before it exits", async () => {
    const scope = await ingestOne(`marker-${randomUUID()}`);
    const holder = await admin.connect();
    try {
      const key = `${EVENTS_AGGREGATE_KIND}:${scope.projectId}`;
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1::text, 0))", [key]);

      const program = launch(environment());
      await waitFor(
        "the job to be taken",
        async () => (await jobStatus(scope.projectId)) === "running",
      );
      program.child.kill("SIGTERM");

      // It has been asked to stop and has not: the job is still waiting for the project's lock.
      await sleep(400);
      expect(program.child.exitCode).toBeNull();

      await holder.query("SELECT pg_advisory_unlock(hashtextextended($1::text, 0))", [key]);
      const result = await program.finished;
      expect(result.code).toBe(0);
      expect(await countOf(scope.projectId)).toBe(1);
      expect(await jobStatus(scope.projectId)).toBe("succeeded");

      const messages = logLines(result.stdout).map((line) => line["msg"]);
      expect(messages.indexOf("shutdown requested")).toBeLessThan(
        messages.indexOf("job succeeded"),
      );
      expect(messages.indexOf("job succeeded")).toBeLessThan(messages.indexOf("shutdown complete"));
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
    }
  });

  it("gives up on a job that will not finish, and leaves nothing of it behind", async () => {
    const scope = await ingestOne(`marker-${randomUUID()}`);
    // Another handler for the project is in progress, so this process's handler has to wait.
    const holder = await admin.connect();
    try {
      const key = `${EVENTS_AGGREGATE_KIND}:${scope.projectId}`;
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1::text, 0))", [key]);

      const program = launch(environment({ SHUTDOWN_TIMEOUT_MS: "500" }));
      await waitFor(
        "the job to be taken",
        async () => (await jobStatus(scope.projectId)) === "running",
      );

      const asked = Date.now();
      program.child.kill("SIGTERM");
      const result = await program.finished;
      expect(result.code).toBe(1);
      expect(Date.now() - asked).toBeLessThan(5_000);
      expect(logLines(result.stdout).map((line) => line["msg"])).toContain(
        "graceful shutdown timed out; exiting with jobs in progress",
      );

      // Its transaction ended with the process: no count was written, and the job is still
      // leased, to be taken again when the lease runs out.
      expect(await countOf(scope.projectId)).toBe(0);
      expect(await jobStatus(scope.projectId)).toBe("running");
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
    }
  });
});
