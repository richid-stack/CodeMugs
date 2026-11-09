import { describe, expect, it } from "vitest";
import { serializeError } from "./logging.js";

/** An error shaped like the ones `pg` throws for a failed statement. */
function databaseError(fields: Record<string, unknown>, message = "something failed"): Error {
  return Object.assign(new Error(message), { severity: "ERROR", ...fields });
}

describe("serializeError", () => {
  it("keeps the type, message and stack of an ordinary error", () => {
    const error = new TypeError("bad thing");
    expect(serializeError(error)).toEqual({
      type: "TypeError",
      message: "bad thing",
      stack: error.stack,
    });
  });

  it("says nothing about a thrown value that is not an error", () => {
    const serialized = serializeError("password=hunter2");
    expect(JSON.stringify(serialized)).not.toContain("hunter2");
    expect(serialized.type).toBe("NonError");
  });

  describe("a database error", () => {
    const failing = databaseError(
      {
        code: "23514",
        detail: "Failing row contains (CANARY-ROW-CONTENT)",
        where: "JSON data, line 1: CANARY-WHERE-CONTENT",
        hint: "CANARY-HINT",
        internalQuery: "SELECT CANARY-QUERY",
        schema: "public",
        table: "events",
        column: "attributes",
        constraint: "events_attributes_check",
        routine: "ExecConstraints",
      },
      'new row for relation "events" violates check constraint "events_attributes_check"',
    );

    it("keeps what an operator needs", () => {
      expect(serializeError(failing)).toMatchObject({
        type: "DatabaseError",
        code: "23514",
        message:
          'new row for relation "events" violates check constraint "events_attributes_check"',
        table: "events",
        column: "attributes",
        constraint: "events_attributes_check",
      });
    });

    it("leaves out the row, the context, the hint and the query, which hold customer data", () => {
      const logged = JSON.stringify(serializeError(failing));
      expect(logged).not.toContain("CANARY");
      expect(logged).not.toContain("detail");
      expect(logged).not.toContain("where");
    });

    it("hides the message of a data exception, which repeats the offending value", () => {
      const error = databaseError(
        { code: "22P02" },
        'invalid input syntax for type uuid: "CANARY-CLIENT-VALUE"',
      );
      const logged = JSON.stringify(serializeError(error));
      expect(logged).not.toContain("CANARY");
      expect(serializeError(error)).toMatchObject({
        code: "22P02",
        message: "database data exception",
      });
    });

    it("does not let the first line of the stack carry the message instead", () => {
      const error = databaseError({ code: "22021" }, 'invalid byte sequence: "CANARY-IN-STACK"');
      expect(error.stack).toContain("CANARY-IN-STACK");
      const { stack } = serializeError(error);
      expect(stack).not.toContain("CANARY");
      expect(stack).toContain("    at ");
    });

    it("gives an empty stack rather than the message when there are no frames", () => {
      const error = databaseError({ code: "22021" }, "CANARY-MESSAGE");
      error.stack = "Error: CANARY-MESSAGE";
      expect(serializeError(error).stack).toBe("");
    });
  });

  describe("what counts as a database error", () => {
    it("needs a SQLSTATE-shaped code and a severity", () => {
      const sneaky = Object.assign(new Error("keep me"), { code: "23514", detail: "CANARY" });
      // No severity: not from the database driver, so it is logged as an ordinary error.
      expect(serializeError(sneaky)).toMatchObject({ type: "Error", message: "keep me" });
    });

    it("does not mistake a system error code such as EPERM for a SQLSTATE", () => {
      const error = databaseError({ code: "EPERM" }, "operation not permitted");
      expect(serializeError(error)).toMatchObject({ type: "Error" });
    });
  });
});
