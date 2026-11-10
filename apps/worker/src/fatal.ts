import { postgresErrorCode } from "@codemugs/storage";
import type { LogFields } from "./logger.js";

/**
 * What may be written about an error that ends the process. The message is left out: a database
 * error can repeat the value it rejected, and that can be customer data (repository invariant 3).
 * The first line of the stack is the message, so it is removed by matching the message itself
 * rather than by looking for the first frame, which a message could imitate. If the stack does not
 * start with the message, no frames are written at all.
 */
export function describeFatal(error: unknown): LogFields {
  if (!(error instanceof Error)) return { errorType: "NonError" };
  const code = postgresErrorCode(error);
  const header = error.message === "" ? error.name : `${error.name}: ${error.message}`;
  const stack = error.stack ?? "";
  const frames = stack.startsWith(header) ? stack.slice(header.length).trim() : "";
  return {
    errorType: error.name,
    ...(code === undefined ? {} : { code }),
    ...(frames === "" ? {} : { frames }),
  };
}
