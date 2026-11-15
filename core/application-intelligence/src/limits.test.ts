import { describe, expect, it } from "vitest";
import { ANALYSIS_LIMITS } from "./constants.js";
import { resolveLimits } from "./limits.js";

describe("resolveLimits", () => {
  it("gives the limits of the host when nothing is asked", () => {
    expect(resolveLimits()).toEqual(ANALYSIS_LIMITS);
  });

  it("lowers a limit that is asked to be lower", () => {
    expect(resolveLimits({ maxFiles: 3, deadlineMs: 0 })).toEqual({
      ...ANALYSIS_LIMITS,
      maxFiles: 3,
      deadlineMs: 0,
    });
  });

  it("never raises a limit above the host's, which is what its schema accepts", () => {
    expect(resolveLimits({ maxFiles: ANALYSIS_LIMITS.maxFiles + 1 }).maxFiles).toBe(
      ANALYSIS_LIMITS.maxFiles,
    );
    expect(resolveLimits({ maxFileBytes: Number.MAX_SAFE_INTEGER }).maxFileBytes).toBe(
      ANALYSIS_LIMITS.maxFileBytes,
    );
  });

  it("refuses a limit it does not know, and a number that is not one", () => {
    expect(() => resolveLimits({ nothing: 1 } as never)).toThrow("unknown limit");
    for (const bad of [-1, Number.NaN, Infinity, "3"]) {
      expect(() => resolveLimits({ maxFiles: bad } as never)).toThrow("not negative");
    }
  });

  it("does not change the host's limits", () => {
    resolveLimits({ maxFiles: 1 });
    expect(ANALYSIS_LIMITS.maxFiles).toBe(20_000);
    expect(Object.isFrozen(ANALYSIS_LIMITS)).toBe(true);
  });
});
