import type { Principal } from "@codemugs/auth";
import { withTenant, type Pool, type TenantClient } from "@codemugs/storage";
import {
  findNode,
  getRun,
  importClosure,
  latestRun,
  listNodes,
  neighbours,
  type GraphNode,
  type Neighbour,
  type ReachedFile,
  type RunRecord,
} from "@codemugs/system-graph-read";

/**
 * What the routes that read a graph need, for the caller named by `principal`. The organisation and
 * the project are the credential's and no argument can change them (invariant 1): a run that is not
 * the key's project's is, to the caller, not there.
 *
 * Each function answers `undefined` when there is no such graph (a run that does not exist, that is
 * another project's or another organisation's, which are not told apart), and `null` where the
 * graph is there and what was asked for in it is not. A function throws a `GraphError` for an
 * argument that is not valid, which the route answers as `400`, and any other error when it cannot
 * decide, which becomes a generic `500`.
 */
export interface GraphService {
  /** The graph of the key's project as it is now: the run that was stored last. */
  latest(principal: Principal): Promise<RunRecord | undefined>;
  /** One run of the key's project. */
  run(principal: Principal, runId: string): Promise<RunRecord | undefined>;
  /** The nodes of a run, in the order of their ids, a page at a time. */
  nodes(
    principal: Principal,
    runId: string,
    options: { readonly kind?: string; readonly limit: number; readonly afterId?: number },
  ): Promise<GraphNode[] | undefined>;
  /** One node, by what it is and its key. */
  node(
    principal: Principal,
    runId: string,
    kind: string,
    key: string,
  ): Promise<GraphNode | null | undefined>;
  /** The nodes one edge away from a node, with the edge that leads there. `null`: no such node. */
  neighbours(
    principal: Principal,
    runId: string,
    nodeId: number,
    options: { readonly direction: "out" | "in"; readonly kind?: string; readonly limit: number },
  ): Promise<Neighbour[] | null | undefined>;
  /** The files that a file reaches by imports. `null`: the path is not a file of the run. */
  imports(
    principal: Principal,
    runId: string,
    path: string,
    options: {
      readonly direction: "importers" | "imports";
      readonly maxDepth?: number;
      readonly limit: number;
    },
  ): Promise<ReachedFile[] | null | undefined>;
}

/**
 * The service over the database. Every call is one read-only transaction of the key's
 * organisation: it finds the run, checks that it is the key's project's, and reads from it, so
 * that what it shows is of one moment and no write is possible.
 */
export function createGraphService(pool: Pool): GraphService {
  /** `undefined` when the run is not the key's project's. `work` must not answer `undefined`. */
  const inRun = <T>(
    principal: Principal,
    runId: string,
    work: (client: TenantClient) => Promise<T>,
  ): Promise<T | undefined> =>
    withTenant(
      pool,
      principal.organisationId,
      async (client) => {
        const run = await getRun(client, runId);
        // A key is for one project: another project of the same organisation is, to it, not found.
        if (run === null || run.projectId !== principal.projectId) return undefined;
        return work(client);
      },
      { readOnly: true },
    );

  return {
    latest: (principal) =>
      withTenant(
        pool,
        principal.organisationId,
        async (client) => (await latestRun(client, principal.projectId)) ?? undefined,
        { readOnly: true },
      ),

    run: (principal, runId) =>
      withTenant(
        pool,
        principal.organisationId,
        async (client) => {
          const run = await getRun(client, runId);
          return run !== null && run.projectId === principal.projectId ? run : undefined;
        },
        { readOnly: true },
      ),

    nodes: (principal, runId, options) =>
      inRun(principal, runId, (client) => listNodes(client, runId, options)),

    node: (principal, runId, kind, key) =>
      inRun(principal, runId, (client) => findNode(client, runId, kind, key)),

    neighbours: (principal, runId, nodeId, options) =>
      inRun(principal, runId, async (client) => {
        // A node that is not there has no edges, which is also what a leaf has: say which it is.
        const [first] = await listNodes(client, runId, { afterId: nodeId - 1, limit: 1 });
        if (first?.id !== nodeId) return null;
        return neighbours(client, runId, nodeId, options);
      }),

    imports: (principal, runId, path, options) =>
      inRun(principal, runId, async (client) => {
        if ((await findNode(client, runId, "file", path)) === null) return null;
        return importClosure(client, runId, path, options);
      }),
  };
}
