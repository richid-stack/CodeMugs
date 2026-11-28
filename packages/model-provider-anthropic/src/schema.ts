import { ProviderFailure } from "@codemugs/model-gateway";

/**
 * Turns the JSON Schema that the gateway makes from a zod schema into one that the provider's
 * structured output accepts. The provider compiles a schema into a grammar and refuses what it
 * cannot: numeric and string constraints, recursion, an object that allows more keys than it
 * lists. The gateway checks the answer against the zod schema in any case, so what is dropped here
 * costs nothing in safety; it is written into the description instead, so that the model is told.
 *
 * A schema that cannot be sent as it means (an object with keys that are not listed, such as a
 * record, which could only ever be answered with `{}`) is **refused**, and is never changed into
 * one that means something else.
 */

/** Keys that are kept. Everything else is dropped, and a constraint among them is said in words. */
const KEPT = new Set([
  "type",
  "properties",
  "required",
  "items",
  "prefixItems",
  "anyOf",
  "allOf",
  "enum",
  "const",
  "description",
  "title",
  "default",
  "$ref",
  "$defs",
  "format",
  "minItems",
  "additionalProperties",
]);

/** Constraints that the provider does not take: dropped, and put in the description. */
const CONSTRAINTS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

const FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

const MAX_DEPTH = 32;
const MAX_NODES = 5_000;
/** The provider's limits on a schema, which it answers with a 400 when they are passed (so nothing need be sent to find out). */
const MAX_OPTIONAL_PROPERTIES = 24;
const MAX_UNION_PROPERTIES = 16;
/** The only references that a schema from zod holds: to the root, or to a definition. */
const LOCAL_REF = /^#(?:\/\$defs\/([^/~]+))?$/;
/** Names that are not a key for the table of references. */
const ROOT = "#";

function refuse(): never {
  throw new ProviderFailure("rejected");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Walk {
  nodes: number;
  /** Properties that are not required, and properties that are a union, over the whole schema. */
  optional: number;
  unions: number;
  /** Which definition (or the root) is being read, and what each refers to. */
  scope: string;
  refs: Map<string, Set<string>>;
}

function convert(node: unknown, depth: number, walk: Walk): Record<string, unknown> {
  if (!isRecord(node) || depth > MAX_DEPTH || ++walk.nodes > MAX_NODES) return refuse();
  const out: Record<string, unknown> = {};
  const said: string[] = [];

  for (const [key, value] of Object.entries(node)) {
    if (key === "oneOf") {
      out["anyOf"] = value;
    } else if (key === "minItems") {
      // The provider takes 0 and 1 only.
      if (value === 0 || value === 1) out[key] = value;
      else said.push(`${key} ${JSON.stringify(value)}`);
    } else if (key === "format") {
      if (typeof value === "string" && FORMATS.has(value)) out[key] = value;
      else said.push(`${key} ${JSON.stringify(value)}`);
    } else if (CONSTRAINTS.has(key)) {
      said.push(`${key} ${JSON.stringify(value)}`);
    } else if (key === "$defs" && depth > 0) {
      // Dropped: nothing can refer to it.
    } else if (key === "$ref") {
      // A reference to another file or address is not followed by the provider, and one that leads
      // back to where it started is a recursion, which it refuses. Both are found here, not there.
      const target = typeof value === "string" ? LOCAL_REF.exec(value) : null;
      if (target === null) return refuse();
      out[key] = value;
      const to = target[1] ?? ROOT;
      const from = walk.refs.get(walk.scope) ?? new Set<string>();
      from.add(to);
      walk.refs.set(walk.scope, from);
    } else if (KEPT.has(key)) {
      out[key] = value;
    }
  }

  const { properties, items, prefixItems, anyOf, allOf, additionalProperties } = out;
  if (properties !== undefined) {
    if (!isRecord(properties)) return refuse();
    const required = Array.isArray(out["required"]) ? out["required"] : [];
    for (const [name, child] of Object.entries(properties)) {
      if (!required.includes(name)) walk.optional += 1;
      if (
        isRecord(child) &&
        (Array.isArray(child["type"]) ||
          child["anyOf"] !== undefined ||
          child["oneOf"] !== undefined)
      ) {
        walk.unions += 1;
      }
    }
    out["properties"] = Object.fromEntries(
      Object.entries(properties).map(([name, child]) => [name, convert(child, depth + 1, walk)]),
    );
  }
  if (items !== undefined) out["items"] = convert(items, depth + 1, walk);
  for (const [key, list] of [
    ["prefixItems", prefixItems],
    ["anyOf", anyOf],
    ["allOf", allOf],
  ] as const) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) return refuse();
    out[key] = list.map((child) => convert(child, depth + 1, walk));
  }
  const defs = out["$defs"];
  if (defs !== undefined) {
    if (!isRecord(defs)) return refuse();
    // Only the root's definitions can be referred to (`#/$defs/name` starts at the root), so only
    // they are kept, and they are all that are read here.
    out["$defs"] = Object.fromEntries(
      Object.entries(defs).map(([name, child]) => {
        walk.scope = name;
        return [name, convert(child, depth + 1, walk)];
      }),
    );
  }

  if (out["type"] === "object" || properties !== undefined) {
    // The provider allows an object no keys but the ones that it lists. A schema that says that it
    // takes others (a record) would be answered with {} and nothing else: that is not the schema.
    if (additionalProperties !== undefined && additionalProperties !== false) return refuse();
    out["additionalProperties"] = false;
  } else if (additionalProperties !== undefined) {
    return refuse();
  }

  if (said.length > 0) {
    const note = `(${said.join("; ")})`;
    out["description"] =
      typeof out["description"] === "string" && out["description"] !== ""
        ? `${out["description"]} ${note}`
        : note;
  }
  return out;
}

/** The schema for the provider's structured output. Throws `ProviderFailure("rejected")`, which bills nothing, for one that cannot be sent as it means. */
export function toProviderSchema(
  schema: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const walk: Walk = { nodes: 0, optional: 0, unions: 0, scope: ROOT, refs: new Map() };
  const converted = convert(schema, 0, walk);
  if (walk.optional > MAX_OPTIONAL_PROPERTIES || walk.unions > MAX_UNION_PROPERTIES)
    return refuse();
  if (hasCycle(walk.refs, converted)) return refuse();
  return converted;
}

/** Whether a reference leads back to where it started, or to a definition that is not there. */
function hasCycle(refs: Map<string, Set<string>>, schema: Record<string, unknown>): boolean {
  const defs = isRecord(schema["$defs"]) ? schema["$defs"] : {};
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string): boolean => {
    if (name !== ROOT && !(name in defs)) return true;
    const seen = state.get(name);
    if (seen === "visiting") return true;
    if (seen === "done") return false;
    state.set(name, "visiting");
    for (const next of refs.get(name) ?? []) if (visit(next)) return true;
    state.set(name, "done");
    return false;
  };
  for (const name of [ROOT, ...Object.keys(defs)]) if (visit(name)) return true;
  return false;
}
