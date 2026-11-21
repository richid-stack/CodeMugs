import type { TenantClient } from "@codemugs/storage";
import { ANALYSE_JOB_KIND } from "./constants.js";
import { uuid } from "./connect.js";
import { RepositoryAnalysisError } from "./errors.js";

/**
 * How an analysis is going, read from the job that does it and from the run that it stores, because
 * a request is never changed:
 *
 * - `queued`: waiting for a worker.
 * - `running`: a worker has it.
 * - `retrying`: it failed, with `failureCode`, and will be tried again.
 * - `succeeded`: the run is stored (`run`).
 * - `failed`: it failed for good, with `failureCode`.
 * - `unknown`: the job has finished or is gone and there is no run, so that nothing says what became of it.
 */
export type AnalysisStatus = "queued" | "running" | "retrying" | "succeeded" | "failed" | "unknown";

export interface AnalysisState {
  readonly requestId: string;
  readonly projectId: string;
  readonly ref: string;
  readonly requestedAt: Date;
  readonly status: AnalysisStatus;
  /** How many times a worker has taken it. */
  readonly attempts: number;
  /** A short code, never a message, for a `retrying` or `failed` analysis. */
  readonly failureCode?: string;
  /** What was stored, for a `succeeded` analysis. The run's id is the request's. */
  readonly run?: {
    readonly revision: string | null;
    readonly nodes: number;
    readonly edges: number;
    readonly truncated: readonly string[];
    readonly analysedAt: Date;
  };
}

interface StateRow {
  id: string;
  project_id: string;
  ref: string;
  created_at: Date;
  job_status: string | null;
  attempts: number | null;
  last_error_code: string | null;
  run_id: string | null;
  revision: string | null;
  node_count: number | null;
  edge_count: number | null;
  truncated: string[] | null;
  analysed_at: Date | null;
}

const STATE = `
  SELECT r.id, r.project_id, r.ref, r.created_at,
         j.status AS job_status, j.attempts, j.last_error_code,
         a.id AS run_id, a.revision, a.node_count, a.edge_count, a.truncated, a.analysed_at
    FROM analysis_requests r
    LEFT JOIN jobs j
           ON j.organisation_id = r.organisation_id AND j.kind = $3 AND j.subject_id = r.id
    LEFT JOIN analysis_runs a
           ON a.organisation_id = r.organisation_id AND a.id = r.id
`;

function toState(row: StateRow): AnalysisState {
  const attempts = row.attempts ?? 0;
  const base = {
    requestId: row.id,
    projectId: row.project_id,
    ref: row.ref,
    requestedAt: row.created_at,
    attempts,
  };
  // A stored run is the answer, whatever the job says: the worker stores the run in the transaction
  // that completes the job (ADR 0030), so a run is only there for a job that finished.
  if (row.run_id !== null) {
    return {
      ...base,
      status: "succeeded",
      run: {
        revision: row.revision,
        nodes: row.node_count ?? 0,
        edges: row.edge_count ?? 0,
        truncated: row.truncated ?? [],
        analysedAt: row.analysed_at ?? row.created_at,
      },
    };
  }
  const failureCode = row.last_error_code === null ? {} : { failureCode: row.last_error_code };
  switch (row.job_status) {
    case "queued":
      // A job that has an error code has been taken and has failed: a retry is waiting.
      return row.last_error_code === null
        ? { ...base, status: "queued" }
        : { ...base, status: "retrying", ...failureCode };
    case "running":
      return { ...base, status: "running" };
    case "dead":
      return { ...base, status: "failed", ...failureCode };
    default:
      return { ...base, status: "unknown" };
  }
}

/** How one analysis is going, or undefined when there is no such request in the organisation. */
export async function getAnalysis(
  client: TenantClient,
  requestId: string,
): Promise<AnalysisState | undefined> {
  const id = uuid.safeParse(requestId);
  if (!id.success) throw new RepositoryAnalysisError("invalid_input");
  const result = await client.query<StateRow>(
    `${STATE} WHERE r.organisation_id = $1 AND r.id = $2`,
    [client.organisationId, id.data, ANALYSE_JOB_KIND],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toState(row);
}

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

/** The analyses of a project, newest first. */
export async function listAnalyses(
  client: TenantClient,
  projectId: string,
  options: { readonly limit?: number } = {},
): Promise<AnalysisState[]> {
  const id = uuid.safeParse(projectId);
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  if (!id.success || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new RepositoryAnalysisError("invalid_input");
  }
  const result = await client.query<StateRow>(
    `${STATE} WHERE r.organisation_id = $1 AND r.project_id = $2
      ORDER BY r.created_at DESC, r.id
      LIMIT $4`,
    [client.organisationId, id.data, ANALYSE_JOB_KIND, limit],
  );
  return result.rows.map(toState);
}
