import type { Principal } from "@codemugs/auth";
import {
  connectRepository,
  getAnalysis,
  getConnection,
  listAnalyses,
  requestAnalysis,
  type AnalysisState,
  type RepositoryConnection,
} from "@codemugs/repository-analysis";
import { withTenant, type Pool } from "@codemugs/storage";

/** What a caller may say when it connects the repository of its project. The project is its key's. */
export interface ConnectInput {
  readonly installationId: number;
  readonly owner: string;
  readonly name: string;
}

/**
 * What the analysis routes need, for the caller named by `principal`. The organisation and the
 * project are the credential's and no argument can change them (invariant 1).
 *
 * A function throws a `RepositoryAnalysisError` for a request that cannot be done, and any other
 * error when it cannot decide (the database is down): the first is the caller's to see, the second
 * becomes a generic 500.
 */
export interface AnalysisService {
  /** Says that the project of the key is this repository. */
  connect(principal: Principal, input: ConnectInput): Promise<RepositoryConnection>;
  /** The repository that the project of the key is, or undefined when it is none. */
  repository(principal: Principal): Promise<RepositoryConnection | undefined>;
  /** Asks for the repository to be analysed at a ref. The analysis is done by a worker, later. */
  request(principal: Principal, input: { readonly ref: string }): Promise<{ id: string }>;
  /** How one analysis is going, or undefined when it is not one of this key's project. */
  analysis(principal: Principal, id: string): Promise<AnalysisState | undefined>;
  /** The analyses of the key's project, newest first. */
  analyses(principal: Principal, options: { readonly limit?: number }): Promise<AnalysisState[]>;
}

/**
 * The service over the database. It only reads and writes rows and puts a job in the queue: it
 * holds no key for GitHub and cannot run anything (ADR 0031).
 */
export function createAnalysisService(pool: Pool): AnalysisService {
  return {
    connect: (principal, input) =>
      withTenant(pool, principal.organisationId, async (client) => {
        // The project is the credential's: it comes last, so that nothing in `input` can replace it.
        await connectRepository(client, { ...input, projectId: principal.projectId });
        // It is there: this is the transaction that made it.
        const connection = await getConnection(client, principal.projectId);
        if (connection === undefined) throw new Error("a connection that was just made is missing");
        return connection;
      }),

    repository: (principal) =>
      withTenant(
        pool,
        principal.organisationId,
        (client) => getConnection(client, principal.projectId),
        {
          readOnly: true,
        },
      ),

    request: (principal, input) =>
      withTenant(pool, principal.organisationId, async (client) => {
        const { requestId } = await requestAnalysis(client, {
          projectId: principal.projectId,
          ref: input.ref,
        });
        return { id: requestId };
      }),

    analysis: (principal, id) =>
      withTenant(
        pool,
        principal.organisationId,
        async (client) => {
          const state = await getAnalysis(client, id);
          // A key is for one project: another project of the same organisation is, to it, not found.
          return state?.projectId === principal.projectId ? state : undefined;
        },
        { readOnly: true },
      ),

    analyses: (principal, options) =>
      withTenant(
        pool,
        principal.organisationId,
        (client) => listAnalyses(client, principal.projectId, options),
        { readOnly: true },
      ),
  };
}
