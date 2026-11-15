import { ANALYSIS_LIMITS } from "./constants.js";

export type AnalysisLimits = { -readonly [Key in keyof typeof ANALYSIS_LIMITS]: number };

/**
 * The limits for one analysis. A caller can lower any of them (a smaller repository budget, or a
 * test that needs to reach one without making twenty thousand files), and can never raise one above
 * what the host's schema accepts, which is `ANALYSIS_LIMITS`.
 */
export function resolveLimits(overrides: Partial<AnalysisLimits> = {}): AnalysisLimits {
  const limits: AnalysisLimits = { ...ANALYSIS_LIMITS };
  for (const [name, value] of Object.entries(overrides)) {
    if (!(name in ANALYSIS_LIMITS)) throw new RangeError("unknown limit");
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new RangeError("a limit is a number that is not negative");
    }
    const key = name as keyof AnalysisLimits;
    limits[key] = Math.min(value, ANALYSIS_LIMITS[key]);
  }
  return limits;
}
