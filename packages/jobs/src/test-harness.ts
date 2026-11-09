// Shared setup for this package's database tests. Not part of the build.
import { randomUUID } from "node:crypto";
import { createPool, withTenant, type Pool } from "@codemugs/storage";
import { adminDatabaseUrl, createTestDatabase, type TestDatabase } from "@codemugs/storage/testing";
import { describe } from "vitest";

/** `describe`, or `describe.skip` when no test database is configured (see the storage README). */
export function describeDatabase(name: string, body: () => void): void {
  (adminDatabaseUrl() === undefined ? describe.skip : describe)(name, body);
}

export interface JobRow {
  id: string;
  organisation_id: string;
  kind: string;
  subject_id: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  lease_token: string | null;
  last_error_code: string | null;
  finished_at: Date | null;
  seconds_until_available: number;
}

export interface Harness {
  database: TestDatabase;
  /** The application role: sees one tenant at a time. */
  app: Pool;
  /** The dispatcher role: finds jobs in every tenant. */
  dispatcher: Pool;
  /** A superuser, for setting up and inspecting state the roles cannot. */
  admin: Pool;
  createOrganisation(name: string): Promise<string>;
  job(id: string): Promise<JobRow>;
  /** Makes a job's time (or running job's lease) have passed, as if time had gone by. */
  expire(id: string): Promise<void>;
  /** How many effect rows a job's handler has written (see `test_effects`). */
  effects(subjectId: string): Promise<number>;
  close(): Promise<void>;
}

export async function startHarness(options: { appConnections?: number } = {}): Promise<Harness> {
  const cleanup: Array<() => Promise<void>> = [];
  const close = async (): Promise<void> => {
    for (const step of cleanup.splice(0)) await step();
  };
  try {
    const database = await createTestDatabase();
    cleanup.unshift(() => database.drop());
    const app = createPool({
      connectionString: database.appUrl,
      maxConnections: options.appConnections ?? 12,
    });
    cleanup.unshift(() => app.end());
    const dispatcher = createPool({ connectionString: database.dispatcherUrl, maxConnections: 6 });
    cleanup.unshift(() => dispatcher.end());
    const admin = createPool({ connectionString: database.adminUrl, maxConnections: 2 });
    cleanup.unshift(() => admin.end());

    // The table a test handler writes to, standing in for real tenant data (an aggregate, say).
    // It is isolated like every tenant table, so a handler really runs under row-level security.
    await admin.query(`
      CREATE TABLE test_effects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES organisations (id),
        subject_id uuid,
        attempt integer NOT NULL
      );
      ALTER TABLE test_effects ENABLE ROW LEVEL SECURITY;
      ALTER TABLE test_effects FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON test_effects TO codemugs_app
        USING (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid)
        WITH CHECK (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid);
      GRANT SELECT, INSERT ON test_effects TO codemugs_app;
    `);

    return {
      database,
      app,
      dispatcher,
      admin,
      async createOrganisation(name) {
        const id = randomUUID();
        await withTenant(app, id, (client) =>
          client.query("INSERT INTO organisations (id, name) VALUES ($1, $2)", [id, name]),
        );
        return id;
      },
      async job(id) {
        const result = await admin.query<JobRow>(
          `SELECT id, organisation_id, kind, subject_id, status, attempts, max_attempts, lease_token,
                  last_error_code, finished_at,
                  extract(epoch FROM available_at - now())::float8 AS seconds_until_available
             FROM jobs WHERE id = $1`,
          [id],
        );
        const row = result.rows[0];
        if (result.rows.length !== 1 || row === undefined) throw new Error("no such job");
        return row;
      },
      async expire(id) {
        await admin.query(
          "UPDATE jobs SET available_at = now() - interval '1 second' WHERE id = $1",
          [id],
        );
      },
      async effects(subjectId) {
        const result = await admin.query<{ n: string }>(
          "SELECT count(*) AS n FROM test_effects WHERE subject_id = $1",
          [subjectId],
        );
        return Number(result.rows[0]?.n ?? 0);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Polls until the condition holds. Fails the test, with the given description, if it never does. */
export async function waitFor(
  description: string,
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
