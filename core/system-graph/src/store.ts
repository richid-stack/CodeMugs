import { repositoryFactsSchema, type RepositoryFacts } from "@codemugs/application-intelligence";
import { postgresErrorCode, type TenantClient } from "@codemugs/storage";
import { z } from "zod";
import { buildGraph } from "./build.js";
import { GraphError } from "./errors.js";

const uuid = z.uuid();
const revision = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

export interface SaveAnalysisInput {
  /**
   * The id of this analysis, chosen by the caller (a job's id, say). Storing the same id again with
   * the same facts is a retry and changes nothing; with other facts it is refused.
   */
  readonly runId: string;
  /** A project of the organisation that the transaction is for. */
  readonly projectId: string;
  /** The commit that was analysed, as a lower-case git object id, when it is known. */
  readonly revision?: string;
  /** What the analysis found. It is checked against the schema again here. */
  readonly facts: RepositoryFacts;
}

export interface SavedAnalysis {
  readonly runId: string;
  /** True when the run was already stored, from the same facts, and nothing was written. */
  readonly duplicate: boolean;
  readonly nodes: number;
  readonly edges: number;
}

const INSERT_RUN = `
  INSERT INTO analysis_runs
    (organisation_id, id, project_id, revision, facts_version, truncated, summary,
     node_count, edge_count, digest)
  VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb, $8, $9, $10)
  ON CONFLICT (organisation_id, id) DO NOTHING
  RETURNING id
`;

const STORED_RUN = `
  SELECT project_id, digest, node_count, edge_count
    FROM analysis_runs
   WHERE organisation_id = $1 AND id = $2
`;

// The arrays are unnested so that a run of many thousands of rows is a few statements and not
// many thousands of round trips.
const INSERT_NODES = `
  INSERT INTO graph_nodes (organisation_id, run_id, id, kind, key, attributes)
  SELECT $1, $2, t.id, t.kind, t.key, t.attributes::jsonb
    FROM unnest($3::int[], $4::text[], $5::text[], $6::text[]) AS t(id, kind, key, attributes)
`;

const INSERT_EDGES = `
  INSERT INTO graph_edges (organisation_id, run_id, from_id, to_id, kind, attributes)
  SELECT $1, $2, t.from_id, t.to_id, t.kind, t.attributes::jsonb
    FROM unnest($3::int[], $4::int[], $5::text[], $6::text[]) AS t(from_id, to_id, kind, attributes)
`;

/**
 * Stores one repository analysis as a run of the system graph, for the organisation that the
 * transaction is for (`withTenant`; invariant 1: the organisation is the credential's, and this
 * takes none from its arguments). The run, its nodes and its edges are written in the caller's
 * transaction, so a run that can be read is a run that is whole.
 *
 * Anything that goes wrong is a {@link GraphError}, which says a code and nothing that came from
 * the facts or the database.
 */
export async function saveAnalysis(
  client: TenantClient,
  input: SaveAnalysisInput,
): Promise<SavedAnalysis> {
  const runId = uuid.safeParse(input.runId);
  const projectId = uuid.safeParse(input.projectId);
  const commit = input.revision === undefined ? undefined : revision.safeParse(input.revision);
  if (!runId.success || !projectId.success || (commit !== undefined && !commit.success)) {
    throw new GraphError("invalid_input");
  }
  // The facts are checked again whatever the caller says about them: this is the last place before
  // they are kept, and a flaw in a parser, or in a caller, must not be stored.
  const facts = repositoryFactsSchema.safeParse(input.facts);
  if (!facts.success) throw new GraphError("facts_rejected");

  const graph = buildGraph(facts.data);

  let inserted;
  try {
    inserted = await client.query(INSERT_RUN, [
      client.organisationId,
      runId.data,
      projectId.data,
      commit?.data ?? null,
      facts.data.version,
      [...graph.truncated],
      JSON.stringify(graph.summary),
      graph.nodes.length,
      graph.edges.length,
      graph.digest,
    ]);
  } catch (error) {
    // A project of another organisation is, to this one, a project that does not exist: the
    // foreign key cannot see it, and it is not told that it does.
    if (postgresErrorCode(error) === "23503") throw new GraphError("project_not_found");
    throw error;
  }

  if (inserted.rowCount === 0) {
    const stored = await client.query<{
      project_id: string;
      digest: string;
      node_count: number;
      edge_count: number;
    }>(STORED_RUN, [client.organisationId, runId.data]);
    const run = stored.rows[0];
    if (run === undefined || run.project_id !== projectId.data || run.digest !== graph.digest) {
      throw new GraphError("run_conflict");
    }
    return { runId: runId.data, duplicate: true, nodes: run.node_count, edges: run.edge_count };
  }

  await client.query(INSERT_NODES, [
    client.organisationId,
    runId.data,
    graph.nodes.map((node) => node.id),
    graph.nodes.map((node) => node.kind),
    graph.nodes.map((node) => node.key),
    graph.nodes.map((node) => JSON.stringify(node.attributes)),
  ]);
  await client.query(INSERT_EDGES, [
    client.organisationId,
    runId.data,
    graph.edges.map((edge) => edge.from),
    graph.edges.map((edge) => edge.to),
    graph.edges.map((edge) => edge.kind),
    graph.edges.map((edge) => JSON.stringify(edge.attributes)),
  ]);
  return {
    runId: runId.data,
    duplicate: false,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
  };
}
