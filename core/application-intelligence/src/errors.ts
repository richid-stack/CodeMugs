/**
 * Why an analysis in the sandbox did not give facts. The code is the whole of the story: a message
 * can be made of what the sandbox printed, a path or the repository's own text, and all of those
 * are untrusted (invariant 2), so an error holds a fixed sentence for its code and nothing else
 * (ADR 0012).
 */
export type AnalysisErrorCode =
  /** The sandbox driver cannot run here. */
  | "sandbox_unavailable"
  /** The driver isolates less than the caller asked for. */
  | "sandbox_too_weak"
  /** The sandbox could not be started, or how the run ended could not be found out. */
  | "sandbox_failed"
  /** The repository's checkout cannot be read. */
  | "repository_unreadable"
  /** The checkout has more than the host will copy for one analysis. */
  | "repository_too_large"
  /** The analyser ended with a failure. */
  | "analysis_failed"
  /** The analyser did not finish before the sandbox's time limit. */
  | "analysis_timed_out"
  /** The analyser went over its memory limit. */
  | "analysis_out_of_memory"
  /** The analyser printed more than the sandbox allows. */
  | "analysis_output_too_large"
  /** The analyser's answer is not facts that the schema accepts. */
  | "analysis_output_rejected";

const MESSAGES: Record<AnalysisErrorCode, string> = {
  sandbox_unavailable: "the sandbox is not available",
  sandbox_too_weak: "the sandbox isolates less than the analysis requires",
  sandbox_failed: "the sandbox could not run the analysis",
  repository_unreadable: "the repository cannot be read",
  repository_too_large: "the repository is larger than one analysis accepts",
  analysis_failed: "the analysis failed",
  analysis_timed_out: "the analysis did not finish in time",
  analysis_out_of_memory: "the analysis ran out of memory",
  analysis_output_too_large: "the analysis printed more than is allowed",
  analysis_output_rejected: "the analysis did not give facts that the schema accepts",
};

export class AnalysisError extends Error {
  readonly code: AnalysisErrorCode;

  constructor(code: AnalysisErrorCode) {
    super(MESSAGES[code]);
    this.name = "AnalysisError";
    this.code = code;
  }
}
