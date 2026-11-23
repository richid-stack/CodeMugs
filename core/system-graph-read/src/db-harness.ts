// Shared setup for this package's database tests. Not part of the build.
import { createOrganisation, createProject } from "@codemugs/auth";
import { createPool, type Pool } from "@codemugs/storage";
import { adminDatabaseUrl, createTestDatabase, type TestDatabase } from "@codemugs/storage/testing";
import { describe } from "vitest";

/** `describe`, or `describe.skip` when no test database is configured (see the storage README). */
export function describeDatabase(name: string, body: () => void): void {
  (adminDatabaseUrl() === undefined ? describe.skip : describe)(name, body);
}

/** An organisation with two projects. */
export interface Tenant {
  readonly organisationId: string;
  readonly projectId: string;
  readonly otherProjectId: string;
}

export interface Harness {
  /** The application role: sees one tenant at a time. */
  readonly app: Pool;
  /** A superuser, for looking at what is really stored. */
  readonly admin: Pool;
  tenant(name: string): Promise<Tenant>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const cleanup: Array<() => Promise<void>> = [];
  const close = async (): Promise<void> => {
    for (const step of cleanup.splice(0)) await step();
  };
  try {
    const database: TestDatabase = await createTestDatabase();
    cleanup.unshift(() => database.drop());
    const app = createPool({ connectionString: database.appUrl, maxConnections: 4 });
    cleanup.unshift(() => app.end());
    const admin = createPool({ connectionString: database.adminUrl, maxConnections: 2 });
    cleanup.unshift(() => admin.end());
    return {
      app,
      admin,
      async tenant(name) {
        const organisationId = (await createOrganisation(app, { name })).id;
        const actor = { type: "system" } as const;
        const project = await createProject(app, organisationId, { name: "p1", actor });
        const other = await createProject(app, organisationId, { name: "p2", actor });
        return { organisationId, projectId: project.id, otherProjectId: other.id };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
