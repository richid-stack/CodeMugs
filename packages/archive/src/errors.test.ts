import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ArchiveError, type ArchiveErrorCode } from "./errors.js";

const CODES: readonly ArchiveErrorCode[] = [
  "invalid_input",
  "corrupt",
  "unsupported_entry",
  "unsafe_path",
  "too_large",
  "write_failed",
  "aborted",
];

describe("ArchiveError", () => {
  it.each(CODES)(
    "%s has its own fixed sentence, which is a sentence and says nothing of an archive's contents",
    (code) => {
      const error = new ArchiveError(code);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("ArchiveError");
      expect(error.code).toBe(code);
      expect(error.message).toMatch(/^the [a-z ,]+$/);
      expect(error.message.length).toBeGreaterThan(20);
      expect(error.message).not.toContain(code);
      expect(JSON.parse(JSON.stringify(error))).toEqual({ name: "ArchiveError", code });
      expect(inspect(error)).toContain(error.message);
    },
  );

  it("gives a different sentence for every code", () => {
    expect(new Set(CODES.map((code) => new ArchiveError(code).message)).size).toBe(CODES.length);
  });
});
