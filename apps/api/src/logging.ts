/** The shape Fastify's logger requires from an error serializer, plus extra fields. */
export interface SerializedError {
  type: string;
  message: string;
  stack: string;
  [key: string]: unknown;
}

/** The stack frames without the first line. V8 puts the error's message there. */
function framesOnly(stack: string | undefined): string {
  if (stack === undefined) return "";
  const firstFrame = stack.indexOf("\n    at ");
  return firstFrame === -1 ? "" : stack.slice(firstFrame + 1);
}

/**
 * Turns an error into what is safe to write to a log. The default serializer copies every own
 * property of the error, and PostgreSQL errors can carry the data that failed: `where` quotes the
 * JSON being parsed, and `detail` can hold a row where row-level security does not hide it. For
 * an event that is customer data (repository invariant 3). Messages about a
 * data exception (SQLSTATE class 22) repeat the offending value too, and so does the first line
 * of the stack, which is why a database error is logged with its frames only.
 *
 * What an operator needs is kept: the kind of error, the SQLSTATE, and which table, column and
 * constraint were involved.
 */
export function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) {
    return { type: "NonError", message: "a value that is not an error was thrown", stack: "" };
  }

  const fields = error as unknown as Record<string, unknown>;
  const code = fields["code"];
  const isDatabaseError =
    typeof code === "string" &&
    /^(?=.*[0-9])[0-9A-Z]{5}$/.test(code) &&
    typeof fields["severity"] === "string";

  if (!isDatabaseError) {
    return { type: error.name, message: error.message, stack: error.stack ?? "" };
  }

  const pick = (key: string): Record<string, unknown> =>
    typeof fields[key] === "string" ? { [key]: fields[key] } : {};
  return {
    type: "DatabaseError",
    code,
    message: code.startsWith("22") ? "database data exception" : error.message,
    stack: framesOnly(error.stack),
    ...pick("schema"),
    ...pick("table"),
    ...pick("column"),
    ...pick("constraint"),
    ...pick("routine"),
  };
}
