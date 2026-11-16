import { createHash } from "node:crypto";
import type { RepositoryFacts } from "@codemugs/application-intelligence";
import { GraphError } from "./errors.js";
import type {
  BuiltEdge,
  BuiltGraph,
  BuiltNode,
  EdgeKind,
  JsonObject,
  JsonValue,
  NodeKind,
} from "./model.js";

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A reference to a node before the nodes have numbers: its kind and its key. */
const ref = (kind: NodeKind, key: string): string => `${kind}\n${key}`;

interface PendingNode {
  readonly kind: NodeKind;
  readonly key: string;
  readonly attributes: JsonObject;
}

interface PendingEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly attributes: JsonObject;
}

/** An object without the keys that have no value, so that "not said" is never stored as null. */
function compact(entries: Readonly<Record<string, JsonValue | undefined>>): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** JSON with its keys in order, so that the same graph is always the same text. */
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${(value as JsonValue[]).map(canonicalJson).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object)
    .sort(compare)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as JsonValue)}`)
    .join(",")}}`;
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(compare);

/**
 * Makes the graph of one repository analysis. It is a pure function of the facts: the same facts
 * give the same nodes with the same numbers, in the same order, and the same digest.
 *
 * Nothing in it is run, read from the disk or looked up: every name in the graph is a string that
 * the analysis said (and that the schema checked), kept as data (invariant 2). A reference to a file
 * that the facts do not list is refused with `facts_rejected`, as the schema already refuses it:
 * this does not trust that it was asked.
 */
export function buildGraph(facts: RepositoryFacts): BuiltGraph {
  const nodes = new Map<string, PendingNode>();
  const edges: PendingEdge[] = [];

  const addNode = (kind: NodeKind, key: string, attributes: JsonObject = {}): string => {
    const reference = ref(kind, key);
    if (!nodes.has(reference)) nodes.set(reference, { kind, key, attributes });
    return reference;
  };
  const addEdge = (from: string, to: string, kind: EdgeKind, attributes: JsonObject = {}): void => {
    edges.push({ from, to, kind, attributes });
  };

  for (const file of facts.files) {
    addNode("file", file.path, {
      bytes: file.bytes,
      language: file.language,
      lines: file.lines,
      role: file.role,
    });
  }

  // Packages, in the order of their directories, so that two packages with one name resolve the same
  // way every time (to the first).
  const packageDirectories = new Set<string>();
  const packageByName = new Map<string, string>();
  for (const entry of [...facts.packages].sort((a, b) => compare(a.directory, b.directory))) {
    packageDirectories.add(entry.directory);
    if (entry.name !== undefined && !packageByName.has(entry.name)) {
      packageByName.set(entry.name, entry.directory);
    }
    addNode(
      "package",
      entry.directory,
      compact({
        moduleType: entry.moduleType,
        name: entry.name,
        private: entry.private,
        scripts: entry.scripts,
        version: entry.version,
      }),
    );
  }

  /** What a package name points at: a package of this repository, or one that it only uses. */
  const packageTarget = (name: string): string => {
    const directory = packageByName.get(name);
    return directory === undefined ? addNode("module", name) : ref("package", directory);
  };

  // Which package a file belongs to: the nearest directory above it that has a package.json.
  const owningPackage = (path: string): string | undefined => {
    let directory = path;
    for (;;) {
      const slash = directory.lastIndexOf("/");
      if (slash < 0) break;
      directory = directory.slice(0, slash);
      if (packageDirectories.has(directory)) return directory;
    }
    return packageDirectories.has(".") ? "." : undefined;
  };
  for (const file of facts.files) {
    const directory = owningPackage(file.path);
    if (directory !== undefined) {
      addEdge(ref("file", file.path), ref("package", directory), "in_package");
    }
  }

  // Imports, one edge for each file and target, with what differs between the imports summarised.
  interface ImportSummary {
    readonly from: string;
    readonly to: string;
    count: number;
    line: number;
    readonly kinds: Set<string>;
  }
  const imported = new Map<string, ImportSummary>();
  let unresolvedImports = 0;
  for (const entry of facts.imports) {
    let to: string;
    switch (entry.target.type) {
      case "internal":
        to = ref("file", entry.target.path);
        break;
      case "package":
        to = packageTarget(entry.target.name);
        break;
      case "builtin":
        to = addNode("builtin", entry.target.name);
        break;
      case "unresolved":
        unresolvedImports += 1;
        continue;
    }
    const from = ref("file", entry.from);
    const key = `${from}\n${to}`;
    const known = imported.get(key);
    if (known === undefined) {
      imported.set(key, { from, to, count: 1, line: entry.line, kinds: new Set([entry.kind]) });
    } else {
      known.count += 1;
      known.line = Math.min(known.line, entry.line);
      known.kinds.add(entry.kind);
    }
  }
  for (const summary of imported.values()) {
    addEdge(summary.from, summary.to, "imports", {
      count: summary.count,
      kinds: sorted(summary.kinds),
      line: summary.line,
    });
  }

  // Dependencies a package declares. A package that lists the same name in two fields (a dev and a
  // peer dependency) has one edge, with both declarations in it.
  for (const entry of facts.packages) {
    const from = ref("package", entry.directory);
    const declared = new Map<string, JsonObject[]>();
    for (const dependency of entry.dependencies) {
      const to = packageTarget(dependency.name);
      if (to === from) continue;
      const list = declared.get(to) ?? [];
      list.push(
        compact({ kind: dependency.kind, range: dependency.range, source: dependency.source }),
      );
      declared.set(to, list);
    }
    for (const [to, list] of declared) {
      list.sort((a, b) => compare(canonicalJson(a), canonicalJson(b)));
      addEdge(from, to, "depends_on", { declared: list });
    }
  }

  for (const variable of facts.envVars) {
    const to = addNode("env_var", variable.name, { reads: variable.reads });
    for (const path of variable.files) addEdge(ref("file", path), to, "reads_env");
  }

  // A route that a file defines twice has one edge, with the first of them in it.
  const defined = new Map<string, PendingEdge & { line: number }>();
  for (const route of facts.routes) {
    const to = addNode("route", `${route.method} ${route.path}`, {
      method: route.method,
      path: route.path,
    });
    const from = ref("file", route.file);
    const key = `${from}\n${to}`;
    const known = defined.get(key);
    if (known === undefined || route.line < known.line) {
      defined.set(key, {
        from,
        to,
        kind: "defines_route",
        line: route.line,
        attributes: { confidence: route.confidence, line: route.line, style: route.style },
      });
    }
  }
  for (const edge of defined.values()) {
    addEdge(edge.from, edge.to, "defines_route", edge.attributes);
  }

  // A framework is one node however it was shown (declared, imported or both).
  const frameworks = new Map<
    string,
    { category: string; usedIn: Record<string, number>; files: Map<string, Set<string>> }
  >();
  for (const framework of [...facts.frameworks].sort(
    (a, b) => compare(a.name, b.name) || compare(a.evidence, b.evidence),
  )) {
    let known = frameworks.get(framework.name);
    if (known === undefined) {
      known = { category: framework.category, usedIn: {}, files: new Map() };
      frameworks.set(framework.name, known);
    }
    known.usedIn[framework.evidence] = framework.usedIn;
    for (const path of framework.files) {
      const evidence = known.files.get(path) ?? new Set<string>();
      evidence.add(framework.evidence);
      known.files.set(path, evidence);
    }
  }
  for (const [name, framework] of frameworks) {
    const to = addNode("framework", name, {
      category: framework.category,
      usedIn: framework.usedIn,
    });
    for (const [path, evidence] of framework.files) {
      addEdge(ref("file", path), to, "uses_framework", { evidence: sorted(evidence) });
    }
  }

  // Numbers, in the order of (kind, key). A node's number says nothing but where it comes in the
  // order, so the same facts always give the same numbers.
  const ordered = [...nodes.values()].sort(
    (a, b) => compare(a.kind, b.kind) || compare(a.key, b.key),
  );
  const numbers = new Map<string, number>();
  const builtNodes: BuiltNode[] = ordered.map((node, id) => {
    numbers.set(ref(node.kind, node.key), id);
    return { id, kind: node.kind, key: node.key, attributes: node.attributes };
  });
  const numberOf = (reference: string): number => {
    const id = numbers.get(reference);
    if (id === undefined) throw new GraphError("facts_rejected");
    return id;
  };
  const builtEdges: BuiltEdge[] = edges
    .map((edge) => ({
      from: numberOf(edge.from),
      to: numberOf(edge.to),
      kind: edge.kind,
      attributes: edge.attributes,
    }))
    .sort((a, b) => a.from - b.from || a.to - b.to || compare(a.kind, b.kind));
  for (let index = 1; index < builtEdges.length; index += 1) {
    const before = builtEdges[index - 1];
    const edge = builtEdges[index];
    if (
      before !== undefined &&
      edge !== undefined &&
      before.from === edge.from &&
      before.to === edge.to &&
      before.kind === edge.kind
    ) {
      // Two edges of one kind between two nodes: the key of the table would refuse it, and the
      // facts could only say it by listing something twice.
      throw new GraphError("facts_rejected");
    }
  }

  const digest = createHash("sha256")
    .update(
      canonicalJson([
        builtNodes.map((node) => [node.id, node.kind, node.key, node.attributes]),
        builtEdges.map((edge) => [edge.from, edge.to, edge.kind, edge.attributes]),
      ]),
    )
    .digest("hex");

  return {
    nodes: builtNodes,
    edges: builtEdges,
    summary: {
      analyser: { name: facts.analyser.name, typescript: facts.analyser.typescript },
      factsVersion: facts.version,
      limits: facts.limits,
      unresolvedImports,
    },
    truncated: [...facts.limits.truncated],
    digest,
  };
}
