import { postgresErrorCode } from "@codemugs/storage";

/** What a kind and an error code look like: short, lower case, no spaces, nothing free-form. */
export const NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

/** The job was not valid, or the options for the queue or worker were not. Never echoes values. */
export class JobConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobConfigurationError";
  }
}

/**
 * Throw this from a handler to fail the job with a short, stable code an operator can search for.
 *
 * The code is stored and logged, so it must never contain customer data: a fixed word such as
 * "upstream_unavailable", never a message built from the work. Anything that is not a valid code
 * is replaced by `invalid_failure_code`. Failures of any other kind are recorded as
 * `handler_error`, and their messages are dropped.
 */
export class JobFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(
      `job failed: ${code}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "JobFailure";
    this.code = code;
    this.retryable = options.retryable ?? true;
  }
}

/**
 * The lease on a job is no longer this worker's: it ran out and another worker took the job, or
 * the job has already finished. Whatever this worker did in its transaction is rolled back.
 */
export class LeaseLostError extends Error {
  constructor() {
    super("the lease on this job is no longer held");
    this.name = "LeaseLostError";
  }
}

export interface Failure {
  code: string;
  retryable: boolean;
}

/**
 * Turns whatever a handler threw into the only thing that is stored: a short code and whether to
 * try again. Messages, stacks and causes are dropped, because they can repeat customer data.
 */
export function classifyFailure(error: unknown): Failure {
  if (error instanceof JobFailure) {
    return {
      code: NAME_PATTERN.test(error.code) ? error.code : "invalid_failure_code",
      retryable: error.retryable,
    };
  }
  const sqlState = postgresErrorCode(error);
  if (sqlState !== undefined) return { code: `db_${sqlState.toLowerCase()}`, retryable: true };
  return { code: "handler_error", retryable: true };
}

/** A short code for an error of the queue itself: the SQLSTATE if there is one, else "unknown". */
export function infrastructureCode(error: unknown): string {
  return postgresErrorCode(error) ?? "unknown";
}
