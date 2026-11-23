/**
 * The system graph: what a repository analysis found, kept as nodes and edges in PostgreSQL, one
 * immutable run for each analysis, isolated by tenant. The design is in ADR 0026.
 *
 * This package builds a graph from facts and stores it, so it depends on the analyser's schema.
 * Reading a graph is `@codemugs/system-graph-read` (ADR 0036), which is re-exported here so that
 * what already imports these names from this package keeps working.
 */
export { buildGraph } from "./build.js";
export type { BuiltEdge, BuiltGraph, BuiltNode } from "./model.js";
export { saveAnalysis, type SaveAnalysisInput, type SavedAnalysis } from "./store.js";
export {
  EDGE_KINDS,
  findNode,
  getRun,
  GraphError,
  importClosure,
  latestRun,
  listNodes,
  MAX_DEPTH,
  MAX_LIMIT,
  neighbours,
  NODE_KINDS,
  type EdgeKind,
  type GraphEdge,
  type GraphErrorCode,
  type GraphNode,
  type ImportClosureOptions,
  type JsonObject,
  type JsonValue,
  type ListNodesOptions,
  type Neighbour,
  type NeighbourOptions,
  type NodeKind,
  type ReachedFile,
  type RunRecord,
} from "@codemugs/system-graph-read";
