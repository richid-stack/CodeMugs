/**
 * The five-character SQLSTATE of an error raised by PostgreSQL, or undefined for any other error.
 * The same rule as `postgresErrorCode` in `@codemugs/storage`, which this package does not depend
 * on so that a process with no database can still log. Five characters, digits or capitals, always
 * with a digit: the digit rule keeps a Node system error such as "EPERM" from being mistaken for
 * one. Both have a test for it.
 */
export function sqlstateOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return typeof error.code === "string" && /^(?=.*[0-9])[0-9A-Z]{5}$/.test(error.code)
      ? error.code
      : undefined;
  }
  return undefined;
}
