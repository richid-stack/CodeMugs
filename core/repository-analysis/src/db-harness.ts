// Shared setup for this package's database tests. Not part of the build.
import { createOrganisation, createProject } from "@codemugs/auth";
import { createPool, postgresErrorCode, type Pool } from "@codemugs/storage";
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
  /** The application role again, in a pool of its own, so that one session does several things. */
  connect(maxConnections: number): Pool;
  tenant(name: string): Promise<Tenant>;
  /** What an operator does: binds a GitHub installation to an organisation. The application cannot. */
  bindInstallation(organisationId: string, installationId: number): Promise<void>;
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
    const admin = createPool({ connectionString: database.adminUrl, maxConnections: 2 });
    cleanup.unshift(() => admin.end());
    return {
      app,
      admin,
      connect(maxConnections) {
        const pool = createPool({ connectionString: database.appUrl, maxConnections });
        cleanup.unshift(() => pool.end());
        return pool;
      },
      async tenant(name) {
        const organisationId = (await createOrganisation(app, { name })).id;
        const actor = { type: "system" } as const;
        const project = await createProject(app, organisationId, { name: "p1", actor });
        const other = await createProject(app, organisationId, { name: "p2", actor });
        return { organisationId, projectId: project.id, otherProjectId: other.id };
      },
      async bindInstallation(organisationId, installationId) {
        await admin.query(
          "INSERT INTO github_installations (organisation_id, installation_id) VALUES ($1, $2)",
          [organisationId, installationId],
        );
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The PostgreSQL error code of a promise that must reject with a database error. */
export async function databaseErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return postgresErrorCode(error);
  }
  throw new Error("expected a database error, and there was none");
}

/** The code of a {@link RepositoryAnalysisError} that a promise must reject with. */
export async function analysisErrorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && error.name === "RepositoryAnalysisError") {
      return (error as Error & { code: string }).code;
    }
    throw error;
  }
  throw new Error("expected a RepositoryAnalysisError, and there was none");
}
