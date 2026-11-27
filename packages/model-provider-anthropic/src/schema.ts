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

function refuse(): never {
  throw new ProviderFailure("rejected");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Walk {
  nodes: number;
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
    } else if (KEPT.has(key)) {
      out[key] = value;
    }
  }

  const { properties, items, prefixItems, anyOf, allOf, additionalProperties } = out;
  if (properties !== undefined) {
    if (!isRecord(properties)) return refuse();
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
    out["$defs"] = Object.fromEntries(
      Object.entries(defs).map(([name, child]) => [name, convert(child, depth + 1, walk)]),
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
  return convert(schema, 0, { nodes: 0 });
}
