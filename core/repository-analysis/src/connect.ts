import { randomUUID } from "node:crypto";
import { postgresErrorCode, type TenantClient } from "@codemugs/storage";
import { z } from "zod";
import { RepositoryAnalysisError } from "./errors.js";

// A UUID is written in lower case once it has been checked: PostgreSQL gives it back that way.
export const uuid = z.uuid().transform((value) => value.toLowerCase());

// The shapes that GitHub allows, which are also what the table accepts, so that nothing that gets
// as far as a request to GitHub can change its path.
// `int()` refuses what a number cannot hold exactly, so there is no upper bound to add.
const installationId = z.number().int().min(1);
const owner = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
const name = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/)
  .refine((value) => value !== "." && value !== "..");

export interface ConnectRepositoryInput {
  /** A project of the organisation that the transaction is for. */
  readonly projectId: string;
  /** An installation of the GitHub App that an operator has bound to this organisation. */
  readonly installationId: number;
  /** The login of the user or organisation that owns the repository on GitHub. */
  readonly owner: string;
  /** The name of the repository on GitHub. */
  readonly name: string;
}

export interface RepositoryConnection {
  readonly connectionId: string;
  readonly projectId: string;
  readonly installationId: number;
  readonly owner: string;
  readonly name: string;
  readonly connectedAt: Date;
}

interface ConnectionRow {
  id: string;
  project_id: string;
  installation_id: string;
  owner: string;
  name: string;
  created_at: Date;
}

const toConnection = (row: ConnectionRow): RepositoryConnection => ({
  connectionId: row.id,
  projectId: row.project_id,
  installationId: Number(row.installation_id),
  owner: row.owner,
  name: row.name,
  connectedAt: row.created_at,
});

/**
 * Says that a project is a repository on GitHub, for the organisation that the transaction is for
 * (`withTenant`; invariant 1: the organisation is the credential's, and this takes none from its
 * arguments).
 *
 * The installation has to be one that an operator has bound to the organisation. A number that is
 * not, whether nobody has it or another organisation has, is `installation_not_found` in both
 * cases, so that the answer does not tell which installations exist. This does not look at GitHub:
 * whether the installation can read the repository is found out, and said, when it is analysed.
 *
 * Anything that goes wrong is a {@link RepositoryAnalysisError}.
 */
export async function connectRepository(
  client: TenantClient,
  input: ConnectRepositoryInput,
): Promise<{ connectionId: string }> {
  const projectId = uuid.safeParse(input.projectId);
  const installation = installationId.safeParse(input.installationId);
  const ownerName = owner.safeParse(input.owner);
  const repositoryName = name.safeParse(input.name);
  if (
    !projectId.success ||
    !installation.success ||
    !ownerName.success ||
    !repositoryName.success
  ) {
    throw new RepositoryAnalysisError("invalid_input");
  }

  const project = await client.query(
    "SELECT 1 FROM projects WHERE organisation_id = $1 AND id = $2",
    [client.organisationId, projectId.data],
  );
  if (project.rowCount === 0) throw new RepositoryAnalysisError("project_not_found");

  const bound = await client.query(
    "SELECT 1 FROM github_installations WHERE organisation_id = $1 AND installation_id = $2",
    [client.organisationId, installation.data],
  );
  if (bound.rowCount === 0) throw new RepositoryAnalysisError("installation_not_found");

  const connectionId = randomUUID();
  try {
    await client.query(
      `INSERT INTO repository_connections
         (organisation_id, id, project_id, provider, installation_id, owner, name)
       VALUES ($1, $2, $3, 'github', $4, $5, $6)`,
      [
        client.organisationId,
        connectionId,
        projectId.data,
        installation.data,
        ownerName.data,
        repositoryName.data,
      ],
    );
  } catch (error) {
    if (postgresErrorCode(error) === "23505")
      throw new RepositoryAnalysisError("connection_exists");
    throw error;
  }
  return { connectionId };
}

/** The repository that a project is, or undefined when it is none. */
export async function getConnection(
  client: TenantClient,
  projectId: string,
): Promise<RepositoryConnection | undefined> {
  const id = uuid.safeParse(projectId);
  if (!id.success) throw new RepositoryAnalysisError("invalid_input");
  const result = await client.query<ConnectionRow>(
    `SELECT id, project_id, installation_id, owner, name, created_at
       FROM repository_connections
      WHERE organisation_id = $1 AND project_id = $2`,
    [client.organisationId, id.data],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toConnection(row);
}
