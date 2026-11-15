import { describe, expect, it } from "vitest";
import { AnalysisError, type AnalysisErrorCode } from "./errors.js";

const CODES: readonly AnalysisErrorCode[] = [
  "sandbox_unavailable",
  "sandbox_too_weak",
  "sandbox_failed",
  "repository_unreadable",
  "repository_too_large",
  "analysis_failed",
  "analysis_timed_out",
  "analysis_out_of_memory",
  "analysis_output_too_large",
  "analysis_output_rejected",
  "cleanup_failed",
];

describe("AnalysisError", () => {
  it("carries its code, a name, and a sentence of its own that is fixed for the code", () => {
    const sentences = new Set<string>();
    for (const code of CODES) {
      const error = new AnalysisError(code);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("AnalysisError");
      expect(error.code).toBe(code);
      // A sentence, and not the code over again: a person reads it in a log.
      expect(error.message).toMatch(/^the [a-z ]+$/);
      expect(error.message).not.toContain("_");
      expect(new AnalysisError(code).message).toBe(error.message);
      sentences.add(error.message);
    }
    // Each code says something different.
    expect(sentences.size).toBe(CODES.length);
  });
});
