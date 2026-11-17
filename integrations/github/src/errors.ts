export type GitHubErrorCode =
  /** An owner, a repository, a reference or a limit is not of the form that GitHub uses. */
  | "invalid_input"
  /** The private key is not a PEM-encoded RSA private key of at least 2,048 bits. */
  | "key_invalid"
  /** GitHub could not be reached, or answered with an error status (kept in `status`). */
  | "request_failed"
  /** GitHub answered, but not with what its API documents, or with more than was allowed. */
  | "response_rejected"
  /** A download was sent to somewhere that is not a host that was allowed. */
  | "redirect_refused"
  /** A download is larger than the limit that was given. */
  | "download_too_large"
  /** The function that was given the bytes of a download failed. */
  | "sink_failed"
  /** GitHub did not answer in time. */
  | "timed_out";

const MESSAGES: Readonly<Record<GitHubErrorCode, string>> = {
  invalid_input: "an argument is not of the form that GitHub uses",
  key_invalid: "the private key is not a PEM-encoded RSA private key (a client secret is not one)",
  request_failed: "the request to GitHub failed",
  response_rejected: "GitHub answered with something other than what its API documents",
  redirect_refused: "a download was sent to a host that is not allowed",
  download_too_large: "the download is larger than the limit",
  sink_failed: "the function that received the download failed",
  timed_out: "GitHub did not answer in time",
};

/**
 * A failure of the GitHub integration, as a short code and a fixed sentence. Nothing that GitHub
 * sent, that a caller gave or that a key or a token held is ever in it: a response body can echo
 * what was sent, and a URL of a download carries a credential of its own (invariant 3 and 6). The
 * HTTP status, a number, is kept apart when there is one.
 */
export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  readonly status: number | undefined;

  constructor(code: GitHubErrorCode, status?: number) {
    super(MESSAGES[code]);
    this.name = "GitHubError";
    this.code = code;
    this.status = status;
  }
}
