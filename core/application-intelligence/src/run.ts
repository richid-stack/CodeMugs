import {
  isolationAtLeast,
  SandboxError,
  validateRunRequest,
  type IsolationLevel,
  type SandboxDriver,
  type SandboxResult,
} from "@codemugs/sandbox-manager";
import { AnalysisError } from "./errors.js";
import { parseRepositoryFacts, FactsRejected, type RepositoryFacts } from "./facts.js";
import { STAGED_ENTRY, STAGED_REPOSITORY_DIRECTORY, stageAnalysis } from "./stage.js";

/**
 * Where things are inside the sandbox, and what it is allowed. Written here and not taken from the
 * caller, because what the analysis may do is not the caller's to decide: the caller chooses the
 * image, the driver and the repository, and the policy is the sandbox manager's to check.
 *
 * - The memory limit is for the whole container, scratch space and shared memory included, and the
 *   parser's heap is set below it, so that a repository that is too big for it ends the analysis
 *   with a failure of its own and not with a kill.
 * - The time limit is above the analyser's own deadline (`ANALYSIS_LIMITS.deadlineMs`), so that an
 *   analysis that runs out of time says so in its answer and is not stopped from outside.
 * - The output limit is the largest the policy allows. What the analysis may print is bounded by
 *   its limits, and a repository that would make more than this fails (`analysis_output_too_large`).
 */
export const ANALYSIS_SANDBOX = Object.freeze({
  sourcePath: "/workspace",
  scratchPath: "/scratch",
  scratchMb: 16,
  limits: Object.freeze({
    cpus: 1,
    memoryMb: 1_024,
    pids: 1_000,
    wallClockSeconds: 180,
    outputBytes: 16 * 1_048_576,
  }),
  /** The parser's heap, in megabytes. */
  heapMb: 768,
});

export type AnalysisPolicyLimits = {
  -readonly [Key in keyof typeof ANALYSIS_SANDBOX.limits]: number;
};

export interface AnalyseInSandboxOptions {
  /** A driver of the sandbox manager. */
  readonly driver: SandboxDriver;
  /** The folder that the driver keeps its working copies in. */
  readonly workspaceRoot: string;
  /** An image with Node 22 in it, pinned by digest. Nothing else is in the image that is needed. */
  readonly image: string;
  /**
   * The weakest isolation that the caller accepts. There is no default: the code that decides what a
   * repository may be run on says so (ADR 0007 decision 5).
   */
  readonly minimumIsolation: IsolationLevel;
  /** The checkout of the repository, as a plain absolute path on the host. */
  readonly repository: string;
  /** Lower limits for a test. The sandbox manager refuses what its policy does not accept. */
  readonly limits?: Partial<AnalysisPolicyLimits>;
}

/**
 * Analyses a repository inside the sandbox, and gives the facts, or throws {@link AnalysisError}.
 *
 * What comes out of the sandbox is untrusted: it is checked against the schema before anything of it
 * is kept, and what the run printed is never put in an error (invariant 2). Nothing of the
 * repository runs here: the host copies the files, and the analyser, which parses them, runs only in
 * the sandbox (invariant 8).
 */
export async function analyseInSandbox(options: AnalyseInSandboxOptions): Promise<RepositoryFacts> {
  const availability = await options.driver.availability().catch(() => undefined);
  if (availability === undefined || !availability.available) {
    throw new AnalysisError("sandbox_unavailable");
  }
  if (!isolationAtLeast(options.driver.isolation, options.minimumIsolation)) {
    throw new AnalysisError("sandbox_too_weak");
  }

  const staged = await stageAnalysis({
    repository: options.repository,
    workspaceRoot: options.workspaceRoot,
  });
  try {
    const result = await runStaged(options, staged.directory);
    return factsOf(result);
  } finally {
    await staged.cleanup();
  }
}

async function runStaged(
  options: AnalyseInSandboxOptions,
  sourceDirectory: string,
): Promise<SandboxResult> {
  let request;
  try {
    request = validateRunRequest(
      {
        policy: {
          image: options.image,
          limits: { ...ANALYSIS_SANDBOX.limits, ...options.limits },
          mounts: {
            source: { containerPath: ANALYSIS_SANDBOX.sourcePath },
            scratch: {
              containerPath: ANALYSIS_SANDBOX.scratchPath,
              sizeMb: ANALYSIS_SANDBOX.scratchMb,
            },
          },
          network: { mode: "none" },
        },
        command: [
          "node",
          `--max-old-space-size=${String(ANALYSIS_SANDBOX.heapMb)}`,
          `${ANALYSIS_SANDBOX.sourcePath}/${STAGED_ENTRY}`,
          `${ANALYSIS_SANDBOX.sourcePath}/${STAGED_REPOSITORY_DIRECTORY}`,
        ],
        sourceDirectory,
      },
      { workspaceRoot: options.workspaceRoot },
    );
  } catch {
    // The request is made here, from values that are written here and an image and a folder from
    // the caller. A refusal is a mistake in one of those, and its text names fields, not values:
    // it is the caller's to read in the log of the sandbox manager, not here.
    throw new AnalysisError("sandbox_failed");
  }
  try {
    return await options.driver.run(request);
  } catch (error) {
    if (error instanceof SandboxError && error.code === "unavailable") {
      throw new AnalysisError("sandbox_unavailable");
    }
    throw new AnalysisError("sandbox_failed");
  }
}

/** What an ended run means. Its text is parsed and checked, and never put in an error. */
function factsOf(result: SandboxResult): RepositoryFacts {
  switch (result.outcome) {
    case "timed_out":
      throw new AnalysisError("analysis_timed_out");
    case "out_of_memory":
      throw new AnalysisError("analysis_out_of_memory");
    case "output_limit_exceeded":
      throw new AnalysisError("analysis_output_too_large");
    case "exited":
      break;
  }
  if (result.exitCode !== 0) throw new AnalysisError("analysis_failed");
  if (result.stdoutTruncated) throw new AnalysisError("analysis_output_too_large");
  try {
    return parseRepositoryFacts(result.stdout);
  } catch (error) {
    if (error instanceof FactsRejected) throw new AnalysisError("analysis_output_rejected");
    throw error;
  }
}
