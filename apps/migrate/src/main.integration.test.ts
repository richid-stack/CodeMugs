import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createPool, loadMigrations, type Pool } from "@codemugs/storage";
import {
  adminDatabaseUrl,
  createTestDatabase,
  MIGRATION_LOCK_KEY,
  type TestDatabase,
} from "@codemugs/storage/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * These run the built program as a separate process, the way a deployment step would: with only
 * its environment, and with signals. They need `pnpm build` first.
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
  if (!existsSync(entry)) throw new Error("apps/migrate/dist/main.js is missing: run pnpm build");
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
  return { child, finished, stdout: () => stdout };
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

  it("exits at once, names the missing variable, and prints nothing on standard output", async () => {
    const result = await launch({}).finished;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("MIGRATION_DATABASE_URL");
    expect(result.stdout).toBe("");
  });

  it("does not take the application's connection variable instead", async () => {
    const result = await launch({
      DATABASE_URL: `postgres://someone:${hidden}@db.example.test:5432/codemugs`,
      DISPATCHER_DATABASE_URL: `postgres://someone:${hidden}@db.example.test:5432/codemugs`,
    }).finished;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("MIGRATION_DATABASE_URL");
    expect(result.stdout + result.stderr).not.toContain(hidden);
  });

  it("never echoes a rejected value or a password", async () => {
    const marker = "rejected-value-marker";
    const result = await launch({
      MIGRATION_DATABASE_URL: `mysql://root:${hidden}@db.example.test/${marker}`,
      MIGRATION_TIMEOUT_MS: marker,
    }).finished;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("MIGRATION_DATABASE_URL");
    expect(result.stderr).toContain("MIGRATION_TIMEOUT_MS");
    expect(result.stdout + result.stderr).not.toContain(marker);
    expect(result.stdout + result.stderr).not.toContain(hidden);
  });
});

describeDatabase("the program with a database", () => {
  const databases: TestDatabase[] = [];
  let admin: Pool;
  let adminOf: TestDatabase;
  let password: string;

  async function emptyDatabase(): Promise<TestDatabase> {
    const database = await createTestDatabase({ migrate: false });
    databases.push(database);
    return database;
  }

  const environment = (url: string, overrides: Record<string, string> = {}) => ({
    MIGRATION_DATABASE_URL: url,
    LOG_LEVEL: "debug",
    ...overrides,
  });

  async function schemaState(database: TestDatabase): Promise<{ table: boolean; users: boolean }> {
    const pool = createPool({ connectionString: database.adminUrl, maxConnections: 1 });
    try {
      const rows = await pool.query<{ table: boolean; users: boolean }>(
        `SELECT to_regclass('schema_migrations') IS NOT NULL AS "table",
                to_regclass('organisations') IS NOT NULL AS users`,
      );
      return rows.rows[0] ?? { table: false, users: false };
    } finally {
      await pool.end();
    }
  }

  beforeAll(async () => {
    adminOf = await createTestDatabase({ migrate: false });
    admin = createPool({ connectionString: adminOf.adminUrl, maxConnections: 2 });
    password = decodeURIComponent(new URL(adminOf.appUrl).password);
  }, 60_000);

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.drop()));
  });

  afterAll(async () => {
    await admin.end();
    await adminOf.drop();
  });

  it("migrates an empty database and exits 0, reporting every migration and no secret", async () => {
    const database = await emptyDatabase();
    const shipped = (await loadMigrations()).map((migration) => migration.version);

    const result = await launch(environment(database.adminUrl)).finished;

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    const lines = logLines(result.stdout);
    expect(
      lines.filter((line) => line["msg"] === "migration applied").map((l) => l["version"]),
    ).toEqual(shipped);
    expect(lines.at(-1)).toMatchObject({
      level: "info",
      msg: "migrations applied",
      applied: shipped.length,
      total: shipped.length,
    });
    expect(await schemaState(database)).toEqual({ table: true, users: true });
    expect(result.stdout + result.stderr).not.toContain(password);
    expect(result.stdout + result.stderr).not.toContain(
      decodeURIComponent(new URL(database.adminUrl).password),
    );
  });

  it("exits 0 on a second run, and says there was nothing to do", async () => {
    const database = await emptyDatabase();
    expect((await launch(environment(database.adminUrl)).finished).code).toBe(0);

    const again = await launch(environment(database.adminUrl)).finished;

    expect(again.code).toBe(0);
    expect(logLines(again.stdout).at(-1)).toMatchObject({
      msg: "database is up to date",
      applied: 0,
    });
  });

  it("follows LOG_LEVEL: a run that goes well prints nothing when only errors are wanted", async () => {
    const database = await emptyDatabase();

    const result = await launch(environment(database.adminUrl, { LOG_LEVEL: "error" })).finished;

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(await schemaState(database)).toEqual({ table: true, users: true });
  });

  it("exits 1 when given a runtime role's connection, and changes nothing", async () => {
    const database = await emptyDatabase();

    const result = await launch(environment(database.appUrl)).finished;

    expect(result.code).toBe(1);
    expect(logLines(result.stdout).at(-1)).toMatchObject({ level: "error", code: "wrong_role" });
    expect(await schemaState(database)).toEqual({ table: false, users: false });
    expect(result.stdout + result.stderr).not.toContain(password);
  });

  it("exits 1 when the database cannot be reached, and does not say where it tried", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    server.close();
    await once(server, "close");
    if (address === null || typeof address === "string") throw new Error("no port");
    const url = new URL(adminOf.adminUrl);
    url.hostname = "127.0.0.1";
    url.port = String(address.port);

    const result = await launch(environment(url.toString())).finished;

    expect(result.code).toBe(1);
    expect(logLines(result.stdout).at(-1)).toMatchObject({
      level: "error",
      code: "database_unreachable",
    });
    expect(result.stdout + result.stderr).not.toContain(String(address.port));
    expect(result.stdout + result.stderr).not.toContain(
      decodeURIComponent(new URL(adminOf.adminUrl).password),
    );
  });

  describe("while another run holds the migration lock", () => {
    /** Holds the lock on this database from outside, as a migration that takes long would. */
    async function holdLock(database: TestDatabase) {
      const holder = createPool({ connectionString: database.adminUrl, maxConnections: 1 });
      const client = await holder.connect();
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      return {
        async release(): Promise<void> {
          await client.query("SELECT pg_advisory_unlock_all()");
          client.release();
          await holder.end();
        },
      };
    }

    /** True once the program has connected and is waiting on the lock. */
    async function waitingOnTheLock(database: TestDatabase): Promise<void> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await admin.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks l JOIN pg_database d ON d.oid = l.database
              WHERE l.locktype = 'advisory' AND NOT l.granted AND d.datname = $1
           ) AS waiting`,
          [database.name],
        );
        if (waiting.rows[0]?.waiting === true) return;
        if (Date.now() > deadline) throw new Error("the program never waited for the lock");
        await sleep(25);
      }
    }

    it("gives up after its time limit, exits 1, and leaves nothing behind", async () => {
      const database = await emptyDatabase();
      const lock = await holdLock(database);
      try {
        const started = Date.now();
        const result = await launch(
          environment(database.adminUrl, { MIGRATION_TIMEOUT_MS: "1000" }),
        ).finished;

        expect(result.code).toBe(1);
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(logLines(result.stdout).at(-1)).toMatchObject({
          level: "fatal",
          code: "timeout",
          timeoutMs: 1000,
        });
        expect(await schemaState(database)).toEqual({ table: false, users: false });
      } finally {
        await lock.release();
      }

      // Nothing is left half done: the next run, with the lock free, does everything.
      const again = await launch(environment(database.adminUrl)).finished;
      expect(again.code).toBe(0);
      expect(await schemaState(database)).toEqual({ table: true, users: true });
    });

    it.each(["SIGTERM", "SIGINT"] as const)(
      "exits 1 on %s, and leaves nothing behind",
      async (signal) => {
        const database = await emptyDatabase();
        const lock = await holdLock(database);
        try {
          const program = launch(environment(database.adminUrl));
          await waitingOnTheLock(database);

          program.child.kill(signal);
          const result = await program.finished;

          expect(result.code).toBe(1);
          expect(logLines(result.stdout).at(-1)).toMatchObject({
            level: "error",
            code: "interrupted",
            signal,
          });
          expect(await schemaState(database)).toEqual({ table: false, users: false });
        } finally {
          await lock.release();
        }
      },
    );
  });
});
