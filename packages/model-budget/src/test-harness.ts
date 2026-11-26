// Shared setup for this package's database tests. Not part of the build.
import { randomUUID } from "node:crypto";
import { createPool, withTenant, type Pool } from "@codemugs/storage";
import { adminDatabaseUrl, createTestDatabase, type TestDatabase } from "@codemugs/storage/testing";
import { describe } from "vitest";

/** `describe`, or `describe.skip` when no test database is configured (see the storage README). */
export function describeDatabase(name: string, body: () => void): void {
  (adminDatabaseUrl() === undefined ? describe.skip : describe)(name, body);
}

export interface Harness {
  database: TestDatabase;
  /** The application role, as one process uses it. */
  app: Pool;
  /** The application role again, as another process would: its own connections. */
  otherApp: Pool;
  /** A superuser, for what an operator does and for looking at what the roles cannot. */
  admin: Pool;
  createOrganisation(name: string): Promise<string>;
  /** What an operator does, with the migration login: gives an organisation a budget. */
  setBudget(organisationId: string, monthlyMicros: number, taskMicros?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const cleanup: Array<() => Promise<void>> = [];
  const close = async (): Promise<void> => {
    for (const step of cleanup.splice(0)) await step();
  };
  try {
    const database = await createTestDatabase();
    cleanup.unshift(() => database.drop());
    const app = createPool({ connectionString: database.appUrl, maxConnections: 30 });
    cleanup.unshift(() => app.end());
    const otherApp = createPool({ connectionString: database.appUrl, maxConnections: 30 });
    cleanup.unshift(() => otherApp.end());
    const admin = createPool({ connectionString: database.adminUrl, maxConnections: 2 });
    cleanup.unshift(() => admin.end());
    return {
      database,
      app,
      otherApp,
      admin,
      async createOrganisation(name) {
        const id = randomUUID();
        await withTenant(app, id, (client) =>
          client.query("INSERT INTO organisations (id, name) VALUES ($1, $2)", [id, name]),
        );
        return id;
      },
      async setBudget(organisationId, monthlyMicros, taskMicros) {
        await admin.query(
          `INSERT INTO model_budgets (organisation_id, monthly_micros, task_micros)
           VALUES ($1, $2, $3)
           ON CONFLICT (organisation_id)
           DO UPDATE SET monthly_micros = $2, task_micros = $3, updated_at = now()`,
          [organisationId, monthlyMicros, taskMicros ?? null],
        );
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
