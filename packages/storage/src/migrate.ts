import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { MigrationError } from "./errors.js";

export interface Migration {
  /** Four digits, starting at 0001 with no gaps. */
  version: string;
  name: string;
  sql: string;
  /** SHA-256 of the file. A changed file after it was applied is an error. */
  checksum: string;
}

/** The migrations shipped with this package. The path works from both `src` and `dist`. */
export const defaultMigrationsDirectory = new URL("../migrations/", import.meta.url);

const MIGRATION_FILE = /^(?<version>\d{4})_(?<name>[a-z0-9_]+)\.sql$/;

// Serialises concurrent runners (for example two replicas starting together).
const MIGRATION_LOCK_KEY = 727_227_001;

/**
 * Reads and validates the migration files. Files that are not `.sql` are ignored. Every `.sql`
 * file must be named `NNNN_description.sql`, and the numbers must run 0001, 0002, ... in order.
 * Migration files must not contain their own BEGIN or COMMIT: each runs inside one transaction.
 */
export async function loadMigrations(
  directory: URL | string = defaultMigrationsDirectory,
): Promise<Migration[]> {
  const path = typeof directory === "string" ? directory : fileURLToPath(directory);
  const files = (await readdir(path)).filter((file) => file.endsWith(".sql")).sort();

  const migrations: Migration[] = [];
  for (const file of files) {
    const groups = MIGRATION_FILE.exec(file)?.groups;
    const version = groups?.["version"];
    const name = groups?.["name"];
    if (version === undefined || name === undefined) {
      throw new MigrationError(`migration file name is not valid: ${file}`);
    }
    const expected = String(migrations.length + 1).padStart(4, "0");
    if (version !== expected) {
      throw new MigrationError(`expected migration ${expected} but found ${version}`, { version });
    }
    const sql = await readFile(join(path, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    migrations.push({ version, name, sql, checksum });
  }
  return migrations;
}

interface AppliedRow {
  version: string;
  checksum: string;
}

function verifyHistory(applied: AppliedRow[], migrations: Migration[]): void {
  applied.forEach((row, index) => {
    const migration = migrations[index];
    if (migration === undefined) {
      throw new MigrationError(
        `the database has applied migration ${row.version}, which this build does not contain`,
        { version: row.version },
      );
    }
    if (migration.version !== row.version) {
      throw new MigrationError(
        `the database history is out of order: expected ${migration.version} but found ${row.version}`,
        { version: row.version },
      );
    }
    if (migration.checksum !== row.checksum) {
      // The file contents are deliberately not printed.
      throw new MigrationError(`migration ${row.version} was changed after it was applied`, {
        version: row.version,
      });
    }
  });
}

/**
 * Applies pending migrations, each in its own transaction, and returns the versions applied by
 * this call. Run it with the privileged migration role, never with the application role.
 */
export async function runMigrations(
  connectionString: string,
  directory?: URL | string,
): Promise<string[]> {
  const migrations = await loadMigrations(directory);

  const client = new Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    // A session-level lock, released when the connection ends.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const history = await client.query<AppliedRow>(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    verifyHistory(history.rows, migrations);

    for (const migration of migrations.slice(history.rows.length)) {
      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [migration.version, migration.name, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new MigrationError(
          `migration ${migration.version} (${migration.name}) failed and was rolled back`,
          { version: migration.version, cause: error },
        );
      }
      applied.push(migration.version);
    }
    return applied;
  } finally {
    await client.end();
  }
}
