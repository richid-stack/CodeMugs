/**
 * The vocabulary of the graph. The database only keeps these within bounds (a short lower-case
 * word), so a kind is added here and needs no migration.
 */
export const NODE_KINDS = [
  /** A file of the repository. The key is its path. */
  "file",
  /** A package of the repository, that is a directory with a package.json. The key is the directory. */
  "package",
  /** A package that the repository uses and does not hold. The key is its name. */
  "module",
  /** A module of the runtime, such as `fs`. The key is its name. */
  "builtin",
  /** An HTTP route. The key is the method and the path: `GET /orders`. */
  "route",
  /** An environment variable that the code reads. The key is its name; its value is never known. */
  "env_var",
  /** A framework or tool that the repository uses. The key is its name. */
  "framework",
] as const;

export const EDGE_KINDS = [
  /** A file imports a file, a package, a module or a built-in module. */
  "imports",
  /** A file belongs to the package whose directory is the nearest above it. */
  "in_package",
  /** A package declares a dependency on a package or a module. */
  "depends_on",
  /** A file reads an environment variable. */
  "reads_env",
  /** A file defines a route. */
  "defines_route",
  /** A file shows the use of a framework. */
  "uses_framework",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** JSON that is stored with a node or an edge: small, and made of what the analysis said. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/** A node as it is read back. The kind is a string because the database does not know the vocabulary. */
export interface GraphNode {
  readonly id: number;
  readonly kind: string;
  readonly key: string;
  readonly attributes: JsonObject;
}

export interface GraphEdge {
  readonly kind: string;
  readonly attributes: JsonObject;
}

export interface RunRecord {
  readonly id: string;
  readonly projectId: string;
  readonly revision: string | null;
  readonly factsVersion: number;
  readonly truncated: readonly string[];
  readonly summary: JsonObject;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly digest: string;
  readonly analysedAt: Date;
}
