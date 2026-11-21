import { randomUUID } from "node:crypto";
import { enqueueJob } from "@codemugs/jobs";
import type { TenantClient } from "@codemugs/storage";
import { z } from "zod";
import { ANALYSE_JOB_ATTEMPTS, ANALYSE_JOB_KIND } from "./constants.js";
import { uuid } from "./connect.js";
import { RepositoryAnalysisError } from "./errors.js";

// What the table accepts, and no more than that: a branch, a tag or a commit as a person wrote it,
// with no space or control character in it. Whether Git would allow it as a name, and whether it is
// there, is found out by the worker, which says so with a code that a retry does not repeat.
const ref = z
  .string()
  .max(255)
  .regex(/^[^\s\p{Cc}]+$/u); // at least one character

export interface RequestAnalysisInput {
  /** A project of the organisation that the transaction is for, that is connected to a repository. */
  readonly projectId: string;
  /** A branch, a tag or a commit of the repository. */
  readonly ref: string;
}

/**
 * Asks for the repository of a project to be analysed at a ref, for the organisation that the
 * transaction is for. The request and the job that does it are written in the caller's
 * transaction, so a request that exists is one that will be done, and the other way round. The
 * analysis itself happens in a worker of its own, which holds the credentials that this does not.
 *
 * The id that comes back is the request's, the job's subject and, once it is done, the run's:
 * {@link getAnalysis} says how it is going. Asking twice is two requests.
 */
export async function requestAnalysis(
  client: TenantClient,
  input: RequestAnalysisInput,
): Promise<{ requestId: string }> {
  const projectId = uuid.safeParse(input.projectId);
  const reference = ref.safeParse(input.ref);
  if (!projectId.success || !reference.success) throw new RepositoryAnalysisError("invalid_input");

  const found = await client.query<{ connection_id: string | null }>(
    `SELECT c.id AS connection_id
       FROM projects p
       LEFT JOIN repository_connections c
              ON c.organisation_id = p.organisation_id AND c.project_id = p.id
      WHERE p.organisation_id = $1 AND p.id = $2`,
    [client.organisationId, projectId.data],
  );
  const project = found.rows[0];
  if (project === undefined) throw new RepositoryAnalysisError("project_not_found");
  if (project.connection_id === null) throw new RepositoryAnalysisError("connection_not_found");

  const requestId = randomUUID();
  await client.query(
    `INSERT INTO analysis_requests (organisation_id, id, project_id, connection_id, ref)
     VALUES ($1, $2, $3, $4, $5)`,
    [client.organisationId, requestId, projectId.data, project.connection_id, reference.data],
  );
  await enqueueJob(client, {
    kind: ANALYSE_JOB_KIND,
    subjectId: requestId,
    maxAttempts: ANALYSE_JOB_ATTEMPTS,
  });
  return { requestId };
}

/** What the worker needs to do an analysis: which commit to look up, and in which repository. */
export interface AnalysisPlan {
  readonly requestId: string;
  readonly projectId: string;
  readonly ref: string;
  readonly installationId: number;
  readonly owner: string;
  readonly name: string;
}

/** The plan of a request, or undefined when there is no such request in the organisation. */
export async function readAnalysisPlan(
  client: TenantClient,
  requestId: string,
): Promise<AnalysisPlan | undefined> {
  const id = uuid.safeParse(requestId);
  if (!id.success) throw new RepositoryAnalysisError("invalid_input");
  const result = await client.query<{
    id: string;
    project_id: string;
    ref: string;
    installation_id: string;
    owner: string;
    name: string;
  }>(
    `SELECT r.id, r.project_id, r.ref, c.installation_id, c.owner, c.name
       FROM analysis_requests r
       JOIN repository_connections c
         ON c.organisation_id = r.organisation_id AND c.id = r.connection_id
      WHERE r.organisation_id = $1 AND r.id = $2`,
    [client.organisationId, id.data],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    requestId: row.id,
    projectId: row.project_id,
    ref: row.ref,
    installationId: Number(row.installation_id),
    owner: row.owner,
    name: row.name,
  };
}
