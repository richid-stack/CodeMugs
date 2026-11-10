import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { runMigrations } from "../migrate.js";
import { APP_ROLE, DISPATCHER_ROLE } from "../roles.js";

// Re-exported so tests keep importing the roles from the test harness.
export { APP_ROLE, DISPATCHER_ROLE };

/**
 * Test harness for tests that need a real PostgreSQL server.
 *
 * Set CODEMUGS_TEST_DATABASE_URL to a connection string for a privileged role (superuser) on a
 * disposable server, for example the one from `pnpm infra:up` or a CI service container. Each
 * test file creates its own database and drops it afterwards, so files can run in parallel.
 *
 * When the variable is missing the database tests are skipped, unless REQUIRE_DATABASE_TESTS is
 * "true" (CI sets it), in which case a missing variable is a failure. A silent skip would let
 * the isolation tests go unrun while everything looks green.
 */

// A throwaway password for roles on a throwaway local test server. Same convention as
// infrastructure/docker/compose.dev.yml. It is never used outside tests.
const ROLE_PASSWORD = "codemugs_dev_only";

// Serialises role and database creation between test files running in parallel.
const SETUP_LOCK_KEY = 727_227_002;

export function adminDatabaseUrl(): string | undefined {
  const url = process.env["CODEMUGS_TEST_DATABASE_URL"];
  if (url === undefined || url === "") {
    if (process.env["REQUIRE_DATABASE_TESTS"] === "true") {
      throw new Error("REQUIRE_DATABASE_TESTS is true but CODEMUGS_TEST_DATABASE_URL is not set");
    }
    return undefined;
  }
  return url;
}

export interface TestDatabase {
  readonly name: string;
  /** Privileged connection string. For migrations, seeding that must bypass tenancy, and checks. */
  readonly adminUrl: string;
  /** Connection string for the restricted application role. */
  readonly appUrl: string;
  /** Connection string for the dispatcher role, which only worker processes hold. */
  readonly dispatcherUrl: string;
  /** Drops the database, ending any connections still open to it. */
  drop(): Promise<void>;
}

function rewrite(
  url: string,
  change: { database?: string; user?: string; password?: string },
): string {
  const parsed = new URL(url);
  if (change.database !== undefined) parsed.pathname = `/${change.database}`;
  if (change.user !== undefined) parsed.username = change.user;
  if (change.password !== undefined) parsed.password = change.password;
  return parsed.toString();
}

async function ensureRole(client: Client, role: string): Promise<void> {
  const attributes = "LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION";
  const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  if (existing.rowCount === 0) {
    await client.query(`CREATE ROLE ${role} ${attributes} PASSWORD '${ROLE_PASSWORD}'`);
  } else {
    // Whatever an earlier run left behind, the role is restricted again before it is used.
    await client.query(`ALTER ROLE ${role} ${attributes} PASSWORD '${ROLE_PASSWORD}'`);
  }
}

/**
 * Creates a fresh database and the restricted role, and by default applies the migrations as the
 * privileged role. Pass `migrate: false` for tests that run migrations themselves.
 */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const baseUrl = adminDatabaseUrl();
  if (baseUrl === undefined) {
    throw new Error("CODEMUGS_TEST_DATABASE_URL is not set");
  }

  // Lower-case hex only, so the name is safe to use as an unquoted identifier.
  const name = `cm_test_${randomBytes(6).toString("hex")}`;

  const maintenance = new Client({ connectionString: baseUrl });
  await maintenance.connect();
  try {
    // A session-level lock, released when the connection ends.
    await maintenance.query("SELECT pg_advisory_lock($1)", [SETUP_LOCK_KEY]);
    await ensureRole(maintenance, APP_ROLE);
    await ensureRole(maintenance, DISPATCHER_ROLE);
    await maintenance.query(`CREATE DATABASE ${name}`);
  } finally {
    await maintenance.end();
  }

  const database: TestDatabase = {
    name,
    adminUrl: rewrite(baseUrl, { database: name }),
    appUrl: rewrite(baseUrl, { database: name, user: APP_ROLE, password: ROLE_PASSWORD }),
    dispatcherUrl: rewrite(baseUrl, {
      database: name,
      user: DISPATCHER_ROLE,
      password: ROLE_PASSWORD,
    }),
    async drop() {
      const client = new Client({ connectionString: baseUrl });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };

  if (options.migrate !== false) {
    try {
      await runMigrations(database.adminUrl);
    } catch (error) {
      await database.drop();
      throw error;
    }
  }
  return database;
}
