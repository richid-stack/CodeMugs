import { AnalysisError, type AnalysisErrorCode } from "@codemugs/application-intelligence";
import { GitHubError } from "@codemugs/github";
import { JobFailure } from "@codemugs/jobs";
import { GraphError } from "@codemugs/system-graph";

/**
 * What an analysis that did not give a graph is recorded as: a short code and whether another try
 * could do better. The code is the whole of the story (ADR 0012): what GitHub, the sandbox or the
 * database said is never kept, because it can hold a path, a name or a value of the repository's
 * own, and the repository is untrusted data (invariant 2).
 *
 * A failure that another try cannot mend is recorded as the last: the job is dead at once and the
 * request says `failed`. One that it can mend (GitHub did not answer, a sandbox was busy) is tried
 * again, as many times as the request allowed.
 */
interface Classified {
  readonly code: string;
  readonly retryable: boolean;
}

const ANALYSIS: Readonly<Record<AnalysisErrorCode, Classified>> = {
  sandbox_unavailable: { code: "sandbox_unavailable", retryable: true },
  // A host that isolates less than the analysis requires will not run it, and another try on the
  // same host is no different.
  sandbox_too_weak: { code: "sandbox_too_weak", retryable: false },
  sandbox_failed: { code: "sandbox_failed", retryable: true },
  repository_unreadable: { code: "repository_unreadable", retryable: false },
  repository_too_large: { code: "repository_too_large", retryable: false },
  analysis_failed: { code: "analysis_failed", retryable: true },
  // The same repository takes as long, and as much memory and output, the next time.
  analysis_timed_out: { code: "analysis_timed_out", retryable: false },
  analysis_out_of_memory: { code: "analysis_out_of_memory", retryable: false },
  analysis_output_too_large: { code: "analysis_output_too_large", retryable: false },
  // The analyser gave something that its own schema refuses: a fault in the analyser, not a thing
  // that a retry mends.
  analysis_output_rejected: { code: "analysis_output_rejected", retryable: false },
  // The analysis may have been fine; a copy of the repository is on the disk and someone has to
  // see to it, and another try may remove it.
  cleanup_failed: { code: "cleanup_failed", retryable: true },
};

function classifyGitHub(error: GitHubError): Classified {
  switch (error.code) {
    case "request_failed": {
      const status = error.status;
      // Not there, or not visible to the installation, or a ref that names no commit.
      if (status === 404 || status === 422) {
        return { code: "repository_or_ref_not_found", retryable: false };
      }
      // Refused: rate limits and a token that was just made look like this too, so it is tried again.
      if (status === 401 || status === 403)
        return { code: "github_access_denied", retryable: true };
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        return { code: "github_rejected", retryable: false };
      }
      return { code: "github_unavailable", retryable: true };
    }
    case "timed_out":
      return { code: "github_unavailable", retryable: true };
    case "download_too_large":
      return { code: "repository_too_large", retryable: false };
    case "invalid_input":
      // The name, the repository or the ref is not of the form that GitHub uses.
      return { code: "request_invalid", retryable: false };
    case "key_invalid":
      // The operator mends this, and may do so between two tries.
      return { code: "github_not_configured", retryable: true };
    case "redirect_refused":
      return { code: "github_redirect_refused", retryable: false };
    case "response_rejected":
    case "sink_failed":
      return { code: "github_response_rejected", retryable: true };
  }
}

/**
 * The failure to record for whatever the work threw: a {@link JobFailure} is kept as it is; a
 * {@link GitHubError}, an {@link AnalysisError} or a {@link GraphError} is turned into its code;
 * and anything else is left alone, so that the worker records it as `handler_error` and drops
 * its message.
 */
export function failureOf(error: unknown): JobFailure | undefined {
  if (error instanceof JobFailure) return error;
  let classified: Classified | undefined;
  if (error instanceof GitHubError) classified = classifyGitHub(error);
  else if (error instanceof AnalysisError) classified = ANALYSIS[error.code];
  else if (error instanceof GraphError) {
    // Facts that the schema refuses or a run id that holds other facts: the same request again
    // would give the same, so it is not tried again.
    classified = { code: `graph_${error.code}`, retryable: false };
  }
  if (classified === undefined) return undefined;
  return new JobFailure(classified.code, { retryable: classified.retryable });
}
