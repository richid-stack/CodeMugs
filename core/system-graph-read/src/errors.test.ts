import { describe, expect, it } from "vitest";
import { GraphError, type GraphErrorCode } from "./errors.js";

const CODES: readonly GraphErrorCode[] = [
  "invalid_input",
  "facts_rejected",
  "project_not_found",
  "run_conflict",
];

describe("GraphError", () => {
  it("is an error with a code and a fixed sentence for each code", () => {
    const sentences = CODES.map((code) => {
      const error = new GraphError(code);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("GraphError");
      expect(error.code).toBe(code);
      expect(error.message.length).toBeGreaterThan(10);
      return error.message;
    });
    expect(new Set(sentences).size).toBe(CODES.length);
  });

  it("takes nothing but the code, so nothing that a caller or a database said can be in it", () => {
    // The constructor's one parameter is the code. A message built from anything else would need
    // another parameter, and this keeps it from growing one unnoticed.
    expect(GraphError.length).toBe(1);
    expect(JSON.stringify(new GraphError("invalid_input"))).not.toMatch(/select|insert|postgres/i);
  });
});
