// Shared setup for this package's database tests. Not part of the build.
import { createOrganisation, createProject } from "@codemugs/auth";
import { connectRepository } from "@codemugs/repository-analysis";
import { createPool, withTenant, type Pool } from "@codemugs/storage";
import { adminDatabaseUrl, createTestDatabase, type TestDatabase } from "@codemugs/storage/testing";
import { describe } from "vitest";

/** `describe`, or `describe.skip` when no test database is configured (see the storage README). */
export function describeDatabase(name: string, body: () => void): void {
  (adminDatabaseUrl() === undefined ? describe.skip : describe)(name, body);
}

/** An organisation with a project that is connected to a repository. */
export interface Tenant {
  readonly organisationId: string;
  readonly projectId: string;
  readonly installationId: number;
  readonly owner: string;
  readonly name: string;
}

export interface Harness {
  /** The application role: sees one tenant at a time. */
  readonly app: Pool;
  /** The dispatcher role: finds jobs in every tenant. */
  readonly dispatcher: Pool;
  /** A superuser, for looking at what is really stored. */
  readonly admin: Pool;
  /** An organisation whose project is a repository, with its installation bound as an operator does. */
  tenant(name: string, installationId: number, owner: string, repository: string): Promise<Tenant>;
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
    const app = createPool({ connectionString: database.appUrl, maxConnections: 12 });
    cleanup.unshift(() => app.end());
    const dispatcher = createPool({ connectionString: database.dispatcherUrl, maxConnections: 4 });
    cleanup.unshift(() => dispatcher.end());
    const admin = createPool({ connectionString: database.adminUrl, maxConnections: 2 });
    cleanup.unshift(() => admin.end());
    return {
      app,
      dispatcher,
      admin,
      async tenant(name, installationId, owner, repository) {
        const organisationId = (await createOrganisation(app, { name })).id;
        const project = await createProject(app, organisationId, {
          name: "p1",
          actor: { type: "system" },
        });
        await admin.query(
          "INSERT INTO github_installations (organisation_id, installation_id) VALUES ($1, $2)",
          [organisationId, installationId],
        );
        await withTenant(app, organisationId, (client) =>
          connectRepository(client, {
            projectId: project.id,
            installationId,
            owner,
            name: repository,
          }),
        );
        return { organisationId, projectId: project.id, installationId, owner, name: repository };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function waitFor(
  description: string,
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
