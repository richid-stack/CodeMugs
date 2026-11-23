export type GraphErrorCode =
  /** An argument is not of the kind that the function takes (an id that is not a UUID, a limit that is not a whole number). */
  | "invalid_input"
  /** The facts do not match the schema of the analysis, so none of them is stored. */
  | "facts_rejected"
  /** The project is not one of this organisation's. */
  | "project_not_found"
  /** A run with this id is already stored, for another project or from other facts. */
  | "run_conflict";

const MESSAGES: Readonly<Record<GraphErrorCode, string>> = {
  invalid_input: "an argument is not valid",
  facts_rejected: "the facts do not match the schema of the analysis",
  project_not_found: "the project was not found",
  run_conflict: "a run with this id is already stored with other facts",
};

/**
 * A failure of the graph store, as a short code and a fixed sentence. Nothing that a repository, a
 * database or a caller said is ever in it: the facts come from a customer's code, and a database
 * error can name tables, columns and values (invariant 6).
 */
export class GraphError extends Error {
  readonly code: GraphErrorCode;

  constructor(code: GraphErrorCode) {
    super(MESSAGES[code]);
    this.name = "GraphError";
    this.code = code;
  }
}
