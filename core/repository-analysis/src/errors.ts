export type RepositoryAnalysisErrorCode =
  /** An argument is not of the kind that the function takes (an id that is not a UUID, a name that GitHub would not allow). */
  | "invalid_input"
  /** The project is not one of this organisation's. */
  | "project_not_found"
  /** The installation is not one that is bound to this organisation (or there is no such installation: the two are not told apart). */
  | "installation_not_found"
  /** The project is a repository already. */
  | "connection_exists"
  /** The project is not connected to a repository. */
  | "connection_not_found";

const MESSAGES: Readonly<Record<RepositoryAnalysisErrorCode, string>> = {
  invalid_input: "an argument is not valid",
  project_not_found: "the project was not found",
  installation_not_found: "the installation was not found",
  connection_exists: "the project is connected to a repository already",
  connection_not_found: "the project is not connected to a repository",
};

/**
 * A failure of the connection or request of an analysis, as a short code and a fixed sentence.
 * Nothing that a caller or a database said is ever in it (invariant 6).
 */
export class RepositoryAnalysisError extends Error {
  readonly code: RepositoryAnalysisErrorCode;

  constructor(code: RepositoryAnalysisErrorCode) {
    super(MESSAGES[code]);
    this.name = "RepositoryAnalysisError";
    this.code = code;
  }
}
