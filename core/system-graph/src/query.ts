import type { TenantClient } from "@codemugs/storage";
import { z } from "zod";
import { GraphError } from "./errors.js";
import type { GraphEdge, GraphNode, JsonObject, RunRecord } from "./model.js";

/**
 * Reads of the system graph. Each takes the client of a tenant transaction (`withTenant`) and sees
 * only that organisation's runs: row-level security decides, and every query also names the
 * organisation, so a mistake in one of them cannot show another tenant's rows.
 *
 * What comes back is data from a customer's repository, and is never instructions (invariant 2).
 */

const uuid = z.uuid();
const DEFAULT_LIMIT = 1_000;
export const MAX_LIMIT = 10_000;
export const MAX_DEPTH = 50;

function id(value: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new GraphError("invalid_input");
  return parsed.data;
}

function whole(value: number | undefined, fallback: number, max: number): number {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < 1 || chosen > max)
    throw new GraphError("invalid_input");
  return chosen;
}

interface RunRow {
  id: string;
  project_id: string;
  revision: string | null;
  facts_version: number;
  truncated: string[];
  summary: JsonObject;
  node_count: number;
  edge_count: number;
  digest: string;
  analysed_at: Date;
}

const RUN_COLUMNS = `id, project_id, revision, facts_version, truncated, summary, node_count,
  edge_count, digest, analysed_at`;

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    revision: row.revision,
    factsVersion: row.facts_version,
    truncated: row.truncated,
    summary: row.summary,
    nodeCount: row.node_count,
    edgeCount: row.edge_count,
    digest: row.digest,
    analysedAt: row.analysed_at,
  };
}

/** A run of this organisation, or null. A run of another organisation is, to this one, no run. */
export async function getRun(client: TenantClient, runId: string): Promise<RunRecord | null> {
  const result = await client.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM analysis_runs WHERE organisation_id = $1 AND id = $2`,
    [client.organisationId, id(runId)],
  );
  const row = result.rows[0];
  return row === undefined ? null : toRun(row);
}

/** The newest run of a project: "the graph as it is now". Null when it was never analysed. */
export async function latestRun(
  client: TenantClient,
  projectId: string,
): Promise<RunRecord | null> {
  const result = await client.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM analysis_runs
      WHERE organisation_id = $1 AND project_id = $2
      ORDER BY analysed_at DESC, id DESC
      LIMIT 1`,
    [client.organisationId, id(projectId)],
  );
  const row = result.rows[0];
  return row === undefined ? null : toRun(row);
}

interface NodeRow {
  id: number;
  kind: string;
  key: string;
  attributes: JsonObject;
}

const toNode = (row: NodeRow): GraphNode => ({
  id: row.id,
  kind: row.kind,
  key: row.key,
  attributes: row.attributes,
});

/** One node of a run, by what it is and its key. */
export async function findNode(
  client: TenantClient,
  runId: string,
  kind: string,
  key: string,
): Promise<GraphNode | null> {
  const result = await client.query<NodeRow>(
    `SELECT id, kind, key, attributes FROM graph_nodes
      WHERE organisation_id = $1 AND run_id = $2 AND kind = $3 AND key = $4`,
    [client.organisationId, id(runId), kind, key],
  );
  const row = result.rows[0];
  return row === undefined ? null : toNode(row);
}

export interface ListNodesOptions {
  /** Only nodes of this kind. */
  readonly kind?: string;
  /** The largest number of nodes to give. At most {@link MAX_LIMIT}; 1,000 when not said. */
  readonly limit?: number;
  /** The id of the last node of the previous page, to give the next one. */
  readonly afterId?: number;
}

/** The nodes of a run, in the order of their ids, a page at a time. */
export async function listNodes(
  client: TenantClient,
  runId: string,
  options: ListNodesOptions = {},
): Promise<GraphNode[]> {
  const limit = whole(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
  if (options.afterId !== undefined && !Number.isInteger(options.afterId)) {
    throw new GraphError("invalid_input");
  }
  const result = await client.query<NodeRow>(
    `SELECT id, kind, key, attributes FROM graph_nodes
      WHERE organisation_id = $1 AND run_id = $2
        AND ($3::text IS NULL OR kind = $3)
        AND id > $4
      ORDER BY id
      LIMIT $5`,
    [client.organisationId, id(runId), options.kind ?? null, options.afterId ?? -1, limit],
  );
  return result.rows.map(toNode);
}

export interface NeighbourOptions {
  /** `out` follows the edges that leave the node, `in` the ones that arrive at it. */
  readonly direction: "out" | "in";
  /** Only edges of this kind. */
  readonly kind?: string;
  readonly limit?: number;
}

export interface Neighbour {
  readonly edge: GraphEdge;
  readonly node: GraphNode;
}

/** The nodes one edge away from a node, with the edge that leads there. */
export async function neighbours(
  client: TenantClient,
  runId: string,
  nodeId: number,
  options: NeighbourOptions,
): Promise<Neighbour[]> {
  const limit = whole(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
  if (!Number.isInteger(nodeId) || nodeId < 0) throw new GraphError("invalid_input");
  if (options.direction !== "out" && options.direction !== "in") {
    throw new GraphError("invalid_input");
  }
  const [near, far] = options.direction === "out" ? ["from_id", "to_id"] : ["to_id", "from_id"];
  const result = await client.query<NodeRow & { edge_kind: string; edge_attributes: JsonObject }>(
    `SELECT n.id, n.kind, n.key, n.attributes, e.kind AS edge_kind, e.attributes AS edge_attributes
       FROM graph_edges e
       JOIN graph_nodes n
         ON n.organisation_id = e.organisation_id AND n.run_id = e.run_id AND n.id = e.${far}
      WHERE e.organisation_id = $1 AND e.run_id = $2 AND e.${near} = $3
        AND ($4::text IS NULL OR e.kind = $4)
      ORDER BY e.kind COLLATE "C", n.kind COLLATE "C", n.key COLLATE "C"
      LIMIT $5`,
    [client.organisationId, id(runId), nodeId, options.kind ?? null, limit],
  );
  return result.rows.map((row) => ({
    edge: { kind: row.edge_kind, attributes: row.edge_attributes },
    node: toNode(row),
  }));
}

export interface ImportClosureOptions {
  /**
   * `importers` finds the files that import the file, and the files that import those: what a
   * change to it can reach. `imports` finds the files it imports, and theirs: what it depends on.
   */
  readonly direction: "importers" | "imports";
  /** How many steps to follow. At most {@link MAX_DEPTH}; 10 when not said. */
  readonly maxDepth?: number;
  /** The largest number of files to give. At most {@link MAX_LIMIT}; 1,000 when not said. */
  readonly limit?: number;
}

export interface ReachedFile {
  readonly node: GraphNode;
  /** The fewest imports between the file and this one. */
  readonly depth: number;
}

/** Code unit order, which is how the builder orders names, and does not depend on a locale. */
const byKey = (a: { key: string }, b: { key: string }): number =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

/**
 * The files that a file reaches through imports of one file by another, nearest first, and in the
 * order of their paths within one depth. A cycle ends (a file is given once, at its nearest depth,
 * and is never the file that was asked about), and the depth and the number of files are bounded,
 * so no repository can make this run long.
 *
 * It walks one level at a time, with a lookup by node number for each, and not as one recursive
 * query: a recursive query is planned before it runs, and for a table that has no statistics yet
 * (just after a large run was stored) the plan was a scan of every edge of the run for every level,
 * 24 seconds for the largest graph that the analysis allows, against 26 milliseconds once the table
 * had been analysed. A walk does the same work whatever the planner knows, ends when the number of
 * files is reached and does not look at a file twice.
 */
export async function importClosure(
  client: TenantClient,
  runId: string,
  path: string,
  options: ImportClosureOptions,
): Promise<ReachedFile[]> {
  const depth = whole(options.maxDepth, 10, MAX_DEPTH);
  const limit = whole(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
  if (options.direction !== "importers" && options.direction !== "imports") {
    throw new GraphError("invalid_input");
  }
  const [near, far] =
    options.direction === "importers" ? ["to_id", "from_id"] : ["from_id", "to_id"];
  const run = id(runId);

  const start = await client.query<{ id: number }>(
    `SELECT id FROM graph_nodes
      WHERE organisation_id = $1 AND run_id = $2 AND kind = 'file' AND key = $3`,
    [client.organisationId, run, path],
  );
  const first = start.rows[0];
  if (first === undefined) return [];

  const seen = new Set<number>([first.id]);
  const reached: ReachedFile[] = [];
  let frontier = [first.id];
  for (let level = 1; level <= depth && frontier.length > 0 && reached.length < limit; level += 1) {
    const edges = await client.query<{ id: number }>(
      `SELECT DISTINCT e.${far} AS id
         FROM graph_edges e
        WHERE e.organisation_id = $1 AND e.run_id = $2 AND e.kind = 'imports'
          AND e.${near} = ANY($3::int[])`,
      [client.organisationId, run, frontier],
    );
    const fresh = edges.rows.map((row) => row.id).filter((node) => !seen.has(node));
    if (fresh.length === 0) break;
    for (const node of fresh) seen.add(node);

    const nodes = await client.query<NodeRow>(
      `SELECT id, kind, key, attributes FROM graph_nodes
        WHERE organisation_id = $1 AND run_id = $2 AND id = ANY($3::int[])`,
      [client.organisationId, run, fresh],
    );
    // Only a file imports, so what is not a file is the end of a path.
    const files = nodes.rows.filter((row) => row.kind === "file").sort(byKey);
    for (const row of files) reached.push({ node: toNode(row), depth: level });
    frontier = files.map((row) => row.id);
  }
  return reached.slice(0, limit);
}
