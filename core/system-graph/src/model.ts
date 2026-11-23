import type { EdgeKind, JsonObject, NodeKind } from "@codemugs/system-graph-read";

export interface BuiltNode {
  /** A number within the run, in the order of (kind, key). */
  readonly id: number;
  readonly kind: NodeKind;
  readonly key: string;
  readonly attributes: JsonObject;
}

export interface BuiltEdge {
  readonly from: number;
  readonly to: number;
  readonly kind: EdgeKind;
  readonly attributes: JsonObject;
}

/** What a repository analysis becomes: nodes, edges, and what to remember of the analysis itself. */
export interface BuiltGraph {
  readonly nodes: readonly BuiltNode[];
  readonly edges: readonly BuiltEdge[];
  /** Counts and limits, never content. */
  readonly summary: JsonObject;
  /** What the analysis had to cut short. Empty when the graph is whole. */
  readonly truncated: readonly string[];
  /** SHA-256 of the nodes and edges, in a fixed form. */
  readonly digest: string;
}
