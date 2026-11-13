import type { SandboxRunRequest } from "./request.js";

/**
 * How strongly a driver separates the code from the host. A hardened container shares the host's
 * kernel, so it is not enough for hostile third-party code (ADR 0007 decision 5). The label says
 * what the driver is, it is not a measurement.
 */
export type IsolationLevel = "hardened-container" | "gvisor" | "microvm";

const STRENGTH: Record<IsolationLevel, number> = {
  "hardened-container": 1,
  gvisor: 2,
  microvm: 3,
};

/** Whether a driver of level `actual` is at least as strong as `required`. */
export function isolationAtLeast(actual: IsolationLevel, required: IsolationLevel): boolean {
  return STRENGTH[actual] >= STRENGTH[required];
}

/**
 * How a run ended. A limit that was reached is an outcome, not an error: the code was stopped, and
 * what it printed up to then is in the result.
 */
export type SandboxOutcome =
  /** The program ended by itself. `exitCode` says how. */
  | "exited"
  /** The wall-clock limit passed and the sandbox was stopped. */
  | "timed_out"
  /** The program wrote more than the policy allows and the sandbox was stopped. */
  | "output_limit_exceeded"
  /**
   * The program went over its memory limit and was stopped: Docker said so, or the program ended
   * by SIGKILL (exit code 137) without a limit of ours having stopped it.
   */
  | "out_of_memory";

export interface SandboxResult {
  readonly outcome: SandboxOutcome;
  /** The program's exit code, or null when it did not end by itself. */
  readonly exitCode: number | null;
  /** What the program wrote, cut at the policy's `outputBytes`. It is untrusted data. */
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}

export type Availability =
  { readonly available: true } | { readonly available: false; readonly reason: string };

/**
 * Isolation is one interface with several drivers behind it, so the technology can be changed
 * without changing the callers (ADR 0007 decision 4).
 */
export interface SandboxDriver {
  /** A short name for logs, such as "docker". */
  readonly name: string;
  readonly isolation: IsolationLevel;
  /** Whether the driver can run here, for example whether a container daemon answers. */
  availability(): Promise<Availability>;
  /**
   * Runs one request and cleans up after it, whatever happens. A driver must call
   * `assertValidatedRequest` before it does anything else, must refuse (never relax) anything it
   * cannot enforce, and must not run a request when it is not available.
   */
  run(request: SandboxRunRequest): Promise<SandboxResult>;
}

export type SandboxErrorCode =
  /** The driver cannot run here, or was asked to run while it was not available. */
  | "unavailable"
  /** The source directory is not a directory inside the workspace, once links are resolved. */
  | "source_not_allowed"
  /** The sandbox could not be started. */
  | "start_failed"
  /** The sandbox started but how the run ended could not be found out. */
  | "run_failed"
  /** The run ended but something it created could not be removed. */
  | "cleanup_failed";

/**
 * A run that did not happen or could not be cleaned up. The message is a fixed sentence for the
 * code: it never contains what the program printed, a path, or anything the runtime said, because
 * all of those can hold data from the customer's code.
 */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode) {
    super(MESSAGES[code]);
    this.name = "SandboxError";
    this.code = code;
  }
}

const MESSAGES: Record<SandboxErrorCode, string> = {
  unavailable: "the sandbox driver is not available",
  source_not_allowed: "the source directory is not allowed",
  start_failed: "the sandbox could not be started",
  run_failed: "the sandbox run could not be completed",
  cleanup_failed: "the sandbox could not be cleaned up",
};
