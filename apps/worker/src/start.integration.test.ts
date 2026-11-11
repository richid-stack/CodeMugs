import { createLogger } from "@codemugs/logging";
import { randomUUID } from "node:crypto";
import { createOrganisation, createProject, issueApiKey } from "@codemugs/auth";
import { loadWorkerConfig } from "@codemugs/configuration";
import { recordEvents, type IngestScope } from "@codemugs/ingestion";
import { enqueueJob, type JobHandler } from "@codemugs/jobs";
import { createPool, withTenant, type Pool } from "@codemugs/storage";
import { adminDatabaseUrl, createTestDatabase, type TestDatabase } from "@codemugs/storage/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WorkerStartupError } from "./preflight.js";
import { APPLICATION_NAME, startWorker, type StartOptions, type WorkerHandle } from "./start.js";

const describeDatabase = adminDatabaseUrl() === undefined ? describe.skip : describe;
const SYSTEM = { type: "system" } as const;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describeDatabase("the worker process's startup and shutdown", () => {
  const running: WorkerHandle[] = [];
  let database: TestDatabase;
  let app: Pool;
  let admin: Pool;
  let orgId: string;
  let password: string;
  let lines: string[];

  function config(overrides: Record<string, string> = {}) {
    return loadWorkerConfig({
      DATABASE_URL: database.appUrl,
      DISPATCHER_DATABASE_URL: database.dispatcherUrl,
      WORKER_CONCURRENCY: "2",
      WORKER_POLL_INTERVAL_MS: "20",
      ...overrides,
    });
  }

  async function start(options: Partial<StartOptions> = {}): Promise<WorkerHandle> {
    const handle = await startWorker({
      config: config(),
      logger: createLogger("debug", (line) => lines.push(line)),
      ...options,
    });
    running.push(handle);
    return handle;
  }

  const oneEvent = () => ({
    schemaVersion: 1,
    eventId: randomUUID(),
    type: "t",
    occurredAt: "2026-03-01T10:15:00Z",
    environment: "production",
    sdk: { name: "sdk-js", version: "1.2.3" },
    attributes: {},
  });

  async function newScope(): Promise<IngestScope> {
    const project = await createProject(app, orgId, {
      name: `p-${randomUUID().slice(0, 8)}`,
      actor: SYSTEM,
    });
    const key = await issueApiKey(app, orgId, project.id, { name: "k", actor: SYSTEM });
    return { organisationId: orgId, projectId: project.id, apiKeyId: key.id };
  }

  async function waitFor(what: string, condition: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(25);
    }
  }

  const statusOf = async (kind: string): Promise<{ status: string; code: string | null }> => {
    const row = await admin.query<{ status: string; last_error_code: string | null }>(
      "SELECT status, last_error_code FROM jobs WHERE organisation_id = $1 AND kind = $2",
      [orgId, kind],
    );
    const first = row.rows[0];
    if (first === undefined) throw new Error("no job of that kind");
    return { status: first.status, code: first.last_error_code };
  };

  const enqueue = (kind: string, maxAttempts = 1): Promise<unknown> =>
    withTenant(app, orgId, (client) => enqueueJob(client, { kind, maxAttempts }));

  /** Connections the database holds for the worker in this test's database. */
  async function openConnections(): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*) FROM pg_stat_activity
        WHERE datname = $1 AND application_name = $2`,
      [database.name, APPLICATION_NAME],
    );
    return Number(result.rows[0]?.count);
  }

  /**
   * The database has no connection of the worker's left. The server notices a closed connection a
   * moment after the client has ended it, so this waits briefly instead of asking once.
   */
  const closed = (): Promise<void> =>
    waitFor("the worker's connections to close", async () => (await openConnections()) === 0);

  beforeAll(async () => {
    database = await createTestDatabase();
    app = createPool({ connectionString: database.appUrl, maxConnections: 4 });
    admin = createPool({ connectionString: database.adminUrl, maxConnections: 2 });
    orgId = (await createOrganisation(app, { name: "A" })).id;
    password = decodeURIComponent(new URL(database.appUrl).password);
  }, 60_000);

  afterEach(async () => {
    for (const handle of running.splice(0)) await handle.stop().catch(() => undefined);
    await admin.query("DELETE FROM jobs WHERE organisation_id = $1", [orgId]);
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
    await database.drop();
  });

  // Reset between tests.
  afterEach(() => {
    lines = [];
  });
  lines = [];

  it("turns ingested events into counts, as the two roles, and logs only identifiers", async () => {
    const scope = await newScope();
    const marker = `marker-${randomUUID()}`;
    const stored = await recordEvents(app, scope, {
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
    expect(stored.ok).toBe(true);

    await start();
    await waitFor("the job to succeed", async () => {
      return (await statusOf("events.aggregate")).status === "succeeded";
    });
    const counts = await admin.query<{ event_count: string }>(
      "SELECT event_count FROM event_aggregates WHERE organisation_id = $1 AND project_id = $2",
      [orgId, scope.projectId],
    );
    expect(counts.rows.map((row) => Number(row.event_count))).toEqual([1]);

    const text = lines.join("\n");
    expect(text).toContain("worker started");
    expect(text).toContain("job succeeded");
    expect(text).toContain(orgId);
    expect(text).not.toContain(marker);
    expect(text).not.toContain(password);
    expect(text).not.toContain(database.appUrl);
  });

  it("logs a job that failed by its code only, never by what its error said", async () => {
    const secret = `customer-value-${randomUUID()}`;
    const handlers: Record<string, JobHandler> = {
      "test.fail": () => Promise.reject(new Error(`could not process ${secret}`)),
    };
    await enqueue("test.fail");
    await start({ handlers });
    await waitFor("the job to be given up on", async () => {
      return (await statusOf("test.fail")).status === "dead";
    });

    expect((await statusOf("test.fail")).code).toBe("handler_error");
    const text = lines.join("\n");
    expect(text).toContain("job failed for good");
    expect(text).toContain("handler_error");
    expect(text).not.toContain(secret);
  });

  it("logs the code of a dropped connection, and carries on with new ones", async () => {
    await start();
    await waitFor("the worker's connections", async () => (await openConnections()) > 0);
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
      [APPLICATION_NAME],
    );
    await waitFor("the dropped connection to be logged", () =>
      Promise.resolve(
        lines.some((line) => {
          const entry = JSON.parse(line) as Record<string, unknown>;
          return entry["msg"] === "database connection error" && entry["code"] === "db_57P01";
        }),
      ),
    );

    // New connections are made, and work goes on.
    const scope = await newScope();
    await recordEvents(app, scope, { events: [oneEvent()] });
    await waitFor("the job to succeed", async () => {
      return (await statusOf("events.aggregate")).status === "succeeded";
    });
    expect(lines.join("\n")).not.toContain(password);
  });

  it("takes no job of a kind it has no handler for", async () => {
    await enqueue("someone.elses");
    const scope = await newScope();
    await recordEvents(app, scope, {
      events: [
        {
          schemaVersion: 1,
          eventId: randomUUID(),
          type: "t",
          occurredAt: "2026-03-01T10:15:00Z",
          environment: "production",
          sdk: { name: "sdk-js", version: "1.2.3" },
          attributes: {},
        },
      ],
    });
    await start();
    // Once the batch is done, the worker has certainly looked at the queue.
    await waitFor("the batch to be processed", async () => {
      return (await statusOf("events.aggregate")).status === "succeeded";
    });
    expect(await statusOf("someone.elses")).toEqual({ status: "queued", code: null });
  });

  describe("stopping", () => {
    it("waits for a job in progress, finishes it, and closes its connections", async () => {
      const entered = gate();
      const release = gate();
      const handlers: Record<string, JobHandler> = {
        "test.slow": async () => {
          entered.open();
          await release.wait;
        },
      };
      await enqueue("test.slow");
      const worker = await start({ handlers });
      await entered.wait;

      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      await sleep(300);
      expect(stopped).toBe(false); // The job is still running.

      release.open();
      await stopping;
      expect(await statusOf("test.slow")).toEqual({ status: "succeeded", code: null });
      await closed();
    });

    it("can be asked twice, and returns at once when there is nothing to wait for", async () => {
      const worker = await start();
      expect(await openConnections()).toBeGreaterThan(0);
      const started = Date.now();
      await worker.stop();
      await worker.stop();
      expect(Date.now() - started).toBeLessThan(2_000);
      await closed();
    });
  });

  describe("when it cannot start", () => {
    it("refuses connections that are the wrong way round, and leaves nothing open", async () => {
      const error = await startWorker({
        config: config({
          DATABASE_URL: database.dispatcherUrl,
          DISPATCHER_DATABASE_URL: database.appUrl,
        }),
        logger: createLogger("silent"),
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WorkerStartupError);
      expect(error).toMatchObject({ code: "wrong_role", variable: "DATABASE_URL" });
      await closed();
    });

    it("takes no job when the check fails", async () => {
      await enqueue("test.never");
      const handlers: Record<string, JobHandler> = { "test.never": () => Promise.resolve() };
      await startWorker({
        config: config({
          DATABASE_URL: database.dispatcherUrl,
          DISPATCHER_DATABASE_URL: database.appUrl,
        }),
        logger: createLogger("silent"),
        handlers,
      }).catch(() => undefined);
      await sleep(200);
      expect(await statusOf("test.never")).toEqual({ status: "queued", code: null });
    });

    it("reports a worker that fails on its own, through `finished` and `stop`", async () => {
      const worker = await startWorker({
        config: config(),
        logger: createLogger("silent"),
        handlers: {}, // A worker needs at least one handler: the library refuses to start.
      });
      await expect(worker.finished).rejects.toThrow(/handler/);
      await expect(worker.stop()).rejects.toThrow(/handler/);
      await closed();
    });
  });
});
