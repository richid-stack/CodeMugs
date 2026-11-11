import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrationConfig } from "@codemugs/configuration";
import { createLogger } from "@codemugs/logging";
import { createPool, loadMigrations, type Pool } from "@codemugs/storage";
import {
  adminDatabaseUrl,
  createTestDatabase,
  findSchemaViolations,
  type TestDatabase,
} from "@codemugs/storage/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrate, type MigrateResult } from "./migrate.js";

const describeDatabase = adminDatabaseUrl() === undefined ? describe.skip : describe;

/** The connection string with another user, host or port. */
function rewrite(base: string, changes: { user?: string; host?: string; port?: string }): string {
  const url = new URL(base);
  if (changes.user !== undefined) url.username = changes.user;
  if (changes.host !== undefined) url.hostname = changes.host;
  if (changes.port !== undefined) url.port = changes.port;
  return url.toString();
}

describeDatabase("the migration command", () => {
  const databases: TestDatabase[] = [];
  const directories: string[] = [];
  const roles: string[] = [];
  let admin: Pool;
  let adminOf: TestDatabase;
  let password: string;

  /** A database with the two roles and nothing else, as infrastructure leaves it. */
  async function emptyDatabase(): Promise<TestDatabase> {
    const database = await createTestDatabase({ migrate: false });
    databases.push(database);
    return database;
  }

  async function migrationFiles(files: Record<string, string>): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "codemugs-migrate-"));
    directories.push(directory);
    for (const [name, sql] of Object.entries(files)) await writeFile(join(directory, name), sql);
    return directory;
  }

  function run(
    url: string,
    extra: { directory?: string; roles?: { app: string; dispatcher: string } } = {},
  ): Promise<MigrateResult> & { lines: string[] } {
    const lines: string[] = [];
    const promise = migrate({
      config: loadMigrationConfig({ MIGRATION_DATABASE_URL: url, LOG_LEVEL: "debug" }),
      logger: createLogger("debug", (line) => lines.push(line)),
      ...extra,
    });
    return Object.assign(promise, { lines });
  }

  const parsed = (lines: string[]): Array<Record<string, unknown>> =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  async function versionsApplied(database: TestDatabase): Promise<string[]> {
    const pool = createPool({ connectionString: database.adminUrl, maxConnections: 1 });
    try {
      const rows = await pool.query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      return rows.rows.map((row) => row.version);
    } finally {
      await pool.end();
    }
  }

  async function hasMigrationTable(database: TestDatabase): Promise<boolean> {
    const pool = createPool({ connectionString: database.adminUrl, maxConnections: 1 });
    try {
      const rows = await pool.query<{ found: boolean }>(
        "SELECT to_regclass('schema_migrations') IS NOT NULL AS found",
      );
      return rows.rows[0]?.found === true;
    } finally {
      await pool.end();
    }
  }

  async function closedPort(): Promise<string> {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    server.close();
    await once(server, "close");
    if (address === null || typeof address === "string") throw new Error("no port");
    return String(address.port);
  }

  beforeAll(async () => {
    // Creates the two roles, which every database in these tests relies on.
    adminOf = await createTestDatabase({ migrate: false });
    admin = createPool({ connectionString: adminOf.adminUrl, maxConnections: 2 });
    password = decodeURIComponent(new URL(adminOf.appUrl).password);
  }, 60_000);

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.drop()));
    await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  afterAll(async () => {
    for (const name of roles) await admin.query(`DROP ROLE IF EXISTS ${name}`);
    await admin.end();
    await adminOf.drop();
  });

  describe("on a database that has not been migrated", () => {
    it("applies every migration, in order, and reports each one", async () => {
      const database = await emptyDatabase();
      const shipped = (await loadMigrations()).map((migration) => migration.version);

      const running = run(database.adminUrl);
      const result = await running;

      expect(result).toEqual({ ok: true, applied: shipped, total: shipped.length });
      expect(await versionsApplied(database)).toEqual(shipped);
      const lines = parsed(running.lines);
      expect(
        lines.filter((l) => l["msg"] === "migration applied").map((l) => l["version"]),
      ).toEqual(shipped);
      expect(lines.at(-1)).toMatchObject({
        level: "info",
        msg: "migrations applied",
        applied: shipped.length,
        total: shipped.length,
      });
    });

    it("leaves a schema that passes the guard for the runtime roles", async () => {
      const database = await emptyDatabase();
      expect((await run(database.adminUrl)).ok).toBe(true);
      const pool = createPool({ connectionString: database.adminUrl, maxConnections: 1 });
      try {
        expect(await findSchemaViolations(pool)).toEqual([]);
      } finally {
        await pool.end();
      }
    });

    it("says there is nothing to do the second time", async () => {
      const database = await emptyDatabase();
      await run(database.adminUrl);
      const running = run(database.adminUrl);
      const result = await running;
      expect(result).toMatchObject({ ok: true, applied: [] });
      expect(parsed(running.lines)).toEqual([
        expect.objectContaining({ level: "info", msg: "database is up to date", applied: 0 }),
      ]);
    });

    it("runs the migrations in a session named codemugs-migrate", async () => {
      const database = await emptyDatabase();
      const directory = await migrationFiles({
        "0001_session.sql":
          "CREATE TABLE session_name AS SELECT current_setting('application_name') AS name;",
      });
      expect(await run(database.adminUrl, { directory })).toMatchObject({ ok: true });
      const pool = createPool({ connectionString: database.adminUrl, maxConnections: 1 });
      try {
        const rows = await pool.query<{ name: string }>("SELECT name FROM session_name");
        expect(rows.rows).toEqual([{ name: "codemugs-migrate" }]);
      } finally {
        await pool.end();
      }
    });

    it("applies each migration once when two runs start together", async () => {
      const database = await emptyDatabase();
      const shipped = (await loadMigrations()).map((migration) => migration.version);
      const [first, second] = await Promise.all([run(database.adminUrl), run(database.adminUrl)]);
      if (!first.ok || !second.ok) throw new Error("both runs should succeed");
      expect([...first.applied, ...second.applied].sort()).toEqual(shipped);
      expect(await versionsApplied(database)).toEqual(shipped);
    });
  });

  describe("before it changes anything", () => {
    it.each(["appUrl", "dispatcherUrl"] as const)(
      "refuses to run as a runtime role (%s)",
      async (which) => {
        const database = await emptyDatabase();
        const running = run(database[which]);
        const result = await running;
        expect(result).toMatchObject({ ok: false, code: "wrong_role" });
        expect(await hasMigrationTable(database)).toBe(false);
        expect(parsed(running.lines)).toEqual([
          expect.objectContaining({ level: "error", code: "wrong_role" }),
        ]);
      },
    );

    it("refuses a database where the roles do not exist, and names them", async () => {
      const database = await emptyDatabase();
      const result = await run(database.adminUrl, {
        roles: { app: "cm_no_such_app_role", dispatcher: "cm_no_such_dispatcher_role" },
      });
      expect(result).toMatchObject({ ok: false, code: "roles_missing" });
      if (result.ok) return;
      expect(result.message).toContain("cm_no_such_app_role");
      expect(result.message).toContain("cm_no_such_dispatcher_role");
      expect(await hasMigrationTable(database)).toBe(false);
    });

    it("names only the role that is missing", async () => {
      const database = await emptyDatabase();
      const result = await run(database.adminUrl, {
        roles: { app: "codemugs_app", dispatcher: "cm_no_such_dispatcher_role" },
      });
      if (result.ok) throw new Error("expected a failure");
      expect(result.message).toContain("cm_no_such_dispatcher_role");
      expect(result.message).not.toContain("codemugs_app");
    });

    it("refuses migration files that are not valid, without connecting", async () => {
      const database = await emptyDatabase();
      const directory = await migrationFiles({
        "0001_ok.sql": "SELECT 1;",
        "0003_gap.sql": "SELECT 1;",
      });
      const result = await run(database.adminUrl, { directory });
      expect(result).toMatchObject({ ok: false, code: "migrations_invalid" });
      expect(await hasMigrationTable(database)).toBe(false);
    });

    it("says it could not reach the database, by code, and does not say where it tried", async () => {
      const database = await emptyDatabase();
      const port = await closedPort();
      const running = run(rewrite(database.adminUrl, { host: "127.0.0.1", port }));
      const result = await running;
      expect(result).toMatchObject({ ok: false, code: "database_unreachable" });
      if (result.ok) return;
      expect(result.message).toContain("ECONNREFUSED");
      const output = running.lines.join("\n") + result.message;
      expect(output).not.toContain(password);
      expect(output).not.toContain(port);
      expect(output).not.toContain("127.0.0.1");
    });

    it("reports a login that may not create anything as a database error, by SQLSTATE", async () => {
      const database = await emptyDatabase();
      const name = `cm_mg_${randomBytes(6).toString("hex")}`;
      await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'`);
      roles.push(name);
      const result = await run(rewrite(database.adminUrl, { user: name }));
      expect(result).toMatchObject({ ok: false, code: "database_error" });
      if (result.ok) return;
      expect(result.message).toContain("db_42501");
    });
  });

  describe("when a migration cannot be applied", () => {
    it("rolls it back, keeps the ones before it, and reports it by version and SQLSTATE only", async () => {
      const database = await emptyDatabase();
      const secret = `customer-value-${randomBytes(6).toString("hex")}`;
      const directory = await migrationFiles({
        "0001_first.sql": "CREATE TABLE first_table (id int);",
        "0002_broken.sql": `DO $$ BEGIN RAISE EXCEPTION '${secret}'; END $$;`,
        "0003_never.sql": "CREATE TABLE never_table (id int);",
      });
      const running = run(database.adminUrl, { directory });
      const result = await running;

      expect(result).toMatchObject({ ok: false, code: "migration_failed", version: "0002" });
      expect(await versionsApplied(database)).toEqual(["0001"]);
      const lines = parsed(running.lines);
      expect(lines.map((l) => l["msg"])).toContain("migration applied");
      expect(lines.at(-1)).toMatchObject({
        level: "error",
        code: "migration_failed",
        version: "0002",
        cause: "db_P0001",
      });
      expect(running.lines.join("\n") + JSON.stringify(result)).not.toContain(secret);
    });

    it("does not say what a rejected value was, when the failure is about data", async () => {
      const database = await emptyDatabase();
      const secret = `customer-value-${randomBytes(6).toString("hex")}`;
      const directory = await migrationFiles({
        "0001_data.sql": `CREATE TABLE t (v int UNIQUE); INSERT INTO t VALUES (1);
                          INSERT INTO t VALUES (1); -- ${secret}`,
      });
      const running = run(database.adminUrl, { directory });
      const result = await running;
      expect(result).toMatchObject({ ok: false, code: "migration_failed", version: "0001" });
      expect(running.lines.join("\n")).toContain("db_23505");
      expect(running.lines.join("\n") + JSON.stringify(result)).not.toContain(secret);
      expect(running.lines.join("\n")).not.toContain("Key (v)");
    });

    it("stops when an applied file has been changed, without printing it", async () => {
      const database = await emptyDatabase();
      const secret = `customer-value-${randomBytes(6).toString("hex")}`;
      const directory = await migrationFiles({ "0001_first.sql": "CREATE TABLE a (id int);" });
      expect((await run(database.adminUrl, { directory })).ok).toBe(true);

      await writeFile(join(directory, "0001_first.sql"), `CREATE TABLE a (id int); -- ${secret}`);
      const running = run(database.adminUrl, { directory });
      const result = await running;
      expect(result).toMatchObject({ ok: false, code: "history_mismatch", version: "0001" });
      if (result.ok) return;
      expect(result.message).toContain("changed after it was applied");
      expect(running.lines.join("\n") + result.message).not.toContain(secret);
    });

    it("stops when the database is ahead of the build", async () => {
      const database = await emptyDatabase();
      const both = await migrationFiles({
        "0001_first.sql": "CREATE TABLE a (id int);",
        "0002_second.sql": "CREATE TABLE b (id int);",
      });
      expect((await run(database.adminUrl, { directory: both })).ok).toBe(true);

      const older = await migrationFiles({ "0001_first.sql": "CREATE TABLE a (id int);" });
      const result = await run(database.adminUrl, { directory: older });
      expect(result).toMatchObject({ ok: false, code: "history_mismatch", version: "0002" });
      expect(await versionsApplied(database)).toEqual(["0001", "0002"]);
    });
  });
});
