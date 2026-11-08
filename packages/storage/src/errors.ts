/** The tenant context was missing, malformed, or used after its transaction ended. */
export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantContextError";
  }
}

/**
 * The five-character SQLSTATE of an error raised by PostgreSQL (for example "23505" for a unique
 * violation), or undefined for any other error. Lets callers map specific failures without
 * matching on message text.
 */
export function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    // Five characters, digits or capitals, always with a digit. The digit rule keeps Node system
    // errors such as "EPERM" from being mistaken for a SQLSTATE.
    return typeof error.code === "string" && /^(?=.*[0-9])[0-9A-Z]{5}$/.test(error.code)
      ? error.code
      : undefined;
  }
  return undefined;
}

/** A migration could not be applied, or the migration history does not match the files. */
export class MigrationError extends Error {
  readonly version: string | undefined;

  constructor(message: string, options: { version?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MigrationError";
    this.version = options.version;
  }
}
