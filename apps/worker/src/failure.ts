import { postgresErrorCode } from "@codemugs/storage";

/**
 * A short, safe description of why a database operation failed: the SQLSTATE of a database error
 * (`db_28P01`), the code of a network error (`ECONNREFUSED`), or `unknown`. Never the message,
 * which can contain the host, the user name or a value the database rejected.
 */
export function describeFailure(error: unknown): string {
  const sqlstate = postgresErrorCode(error);
  if (sqlstate !== undefined) return `db_${sqlstate}`;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && /^E[A-Z]{3,20}$/.test(code)) return code;
  }
  return "unknown";
}
