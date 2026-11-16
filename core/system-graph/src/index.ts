/**
 * The system graph: what a repository analysis found, kept as nodes and edges in PostgreSQL, one
 * immutable run for each analysis, isolated by tenant. The design is in ADR 0026.
 */
export { buildGraph } from "./build.js";
export { GraphError, type GraphErrorCode } from "./errors.js";
export {
  EDGE_KINDS,
  NODE_KINDS,
  type BuiltEdge,
  type BuiltGraph,
  type BuiltNode,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type JsonObject,
  type JsonValue,
  type NodeKind,
  type RunRecord,
} from "./model.js";
export {
  findNode,
  getRun,
  importClosure,
  latestRun,
  listNodes,
  MAX_DEPTH,
  MAX_LIMIT,
  neighbours,
  type ImportClosureOptions,
  type ListNodesOptions,
  type Neighbour,
  type NeighbourOptions,
  type ReachedFile,
} from "./query.js";
export { saveAnalysis, type SaveAnalysisInput, type SavedAnalysis } from "./store.js";
