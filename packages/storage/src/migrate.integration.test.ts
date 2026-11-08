import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { MigrationError } from "./errors.js";
import { loadMigrations, runMigrations } from "./migrate.js";
import { adminDatabaseUrl, createTestDatabase, type TestDatabase } from "./testing/postgres.js";

const describeDatabase = adminDatabaseUrl() === undefined ? describe.skip : describe;

describeDatabase("migrations against PostgreSQL", () => {
  const databases: TestDatabase[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.drop()));
    await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function emptyDatabase(): Promise<TestDatabase> {
    const database = await createTestDatabase({ migrate: false });
    databases.push(database);
    return database;
  }

  async function migrationFiles(files: Record<string, string>): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "codemugs-migrations-"));
    directories.push(directory);
    for (const [name, sql] of Object.entries(files)) {
      await writeFile(join(directory, name), sql);
    }
    return directory;
  }

  async function query<R extends Record<string, unknown>>(url: string, sql: string): Promise<R[]> {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      return (await client.query<R>(sql)).rows;
    } finally {
      await client.end();
    }
  }

  async function failureOf(promise: Promise<unknown>): Promise<MigrationError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof MigrationError) return error;
      throw error;
    }
    throw new Error("expected the migration run to fail");
  }

  it("applies every migration once and records its name and checksum", async () => {
    const database = await emptyDatabase();
    const shipped = await loadMigrations();

    expect(await runMigrations(database.adminUrl)).toEqual(shipped.map((m) => m.version));
    expect(await runMigrations(database.adminUrl)).toEqual([]);

    const recorded = await query<{ version: string; name: string; checksum: string }>(
      database.adminUrl,
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    );
    expect(recorded).toEqual(
      shipped.map(({ version, name, checksum }) => ({ version, name, checksum })),
    );
  });

  it("refuses to run when an applied migration file has changed, without printing the SQL", async () => {
    const database = await emptyDatabase();
    const directory = await migrationFiles({ "0001_a.sql": "CREATE TABLE a (id int);" });
    await runMigrations(database.adminUrl, directory);

    await writeFile(join(directory, "0001_a.sql"), "CREATE TABLE a (id int, sneaky_column int);");
    const error = await failureOf(runMigrations(database.adminUrl, directory));

    expect(error.version).toBe("0001");
    expect(error.message).toMatch(/changed after it was applied/);
    expect(error.message).not.toContain("sneaky_column");
  });

  it("refuses to run when the database is ahead of this build", async () => {
    const database = await emptyDatabase();
    const both = await migrationFiles({
      "0001_a.sql": "CREATE TABLE a (id int);",
      "0002_b.sql": "CREATE TABLE b (id int);",
    });
    await runMigrations(database.adminUrl, both);

    const older = await migrationFiles({ "0001_a.sql": "CREATE TABLE a (id int);" });
    const error = await failureOf(runMigrations(database.adminUrl, older));

    expect(error.version).toBe("0002");
    expect(error.message).toMatch(/does not contain/);
  });

  it("rolls a failing migration back completely and lets the next run retry it", async () => {
    const database = await emptyDatabase();
    const directory = await migrationFiles({
      "0001_ok.sql": "CREATE TABLE ok (id int);",
      "0002_bad.sql": "CREATE TABLE half_done (id int); SELECT 1 / 0;",
    });

    const error = await failureOf(runMigrations(database.adminUrl, directory));
    expect(error.version).toBe("0002");
    expect(error.cause).toBeInstanceOf(Error);

    const state = await query<{ ok: string | null; half_done: string | null }>(
      database.adminUrl,
      "SELECT to_regclass('ok')::text AS ok, to_regclass('half_done')::text AS half_done",
    );
    expect(state).toEqual([{ ok: "ok", half_done: null }]);
    const applied = await query<{ version: string }>(
      database.adminUrl,
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(applied).toEqual([{ version: "0001" }]);

    // The failed file was never recorded, so correcting it and running again applies it.
    await writeFile(join(directory, "0002_bad.sql"), "CREATE TABLE half_done (id int);");
    expect(await runMigrations(database.adminUrl, directory)).toEqual(["0002"]);
  });

  it("applies each migration exactly once when several runners start together", async () => {
    const database = await emptyDatabase();
    const shipped = await loadMigrations();

    const results = await Promise.all(
      Array.from({ length: 4 }, () => runMigrations(database.adminUrl)),
    );

    expect(results.flat()).toEqual(shipped.map((m) => m.version));
  });
});
