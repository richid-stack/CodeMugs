/** The tenant context was missing, malformed, or used after its transaction ended. */
export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantContextError";
  }
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
