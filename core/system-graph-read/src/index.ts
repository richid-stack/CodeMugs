/**
 * Reading the system graph: the runs that analyses stored, their nodes and what joins them, seen
 * one tenant at a time. This is all that the API needs of the graph, so it is a package of its own
 * that needs neither the analyser nor the sandbox (ADR 0036). Building a graph from facts and
 * storing it is `@codemugs/system-graph`, which re-exports everything here.
 */
export { GraphError, type GraphErrorCode } from "./errors.js";
export {
  EDGE_KINDS,
  NODE_KINDS,
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
