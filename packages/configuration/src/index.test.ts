import { describe, expect, it } from "vitest";
import { ConfigError, loadApiConfig } from "./index.js";

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("loadApiConfig", () => {
  it("applies safe defaults when nothing is set", () => {
    expect(loadApiConfig({})).toEqual({
      nodeEnv: "development",
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      shutdownTimeoutMs: 10_000,
      bodyLimitBytes: 1_048_576,
    });
  });

  it("coerces numeric values from strings", () => {
    const config = loadApiConfig({ PORT: "8080", SHUTDOWN_TIMEOUT_MS: "2500" });
    expect(config.port).toBe(8080);
    expect(config.shutdownTimeoutMs).toBe(2500);
  });

  it("rejects invalid values and names every offending variable", () => {
    const error = captureError(() => loadApiConfig({ PORT: "99999", LOG_LEVEL: "loud" }));
    if (!(error instanceof ConfigError)) {
      throw new Error("expected a ConfigError");
    }
    expect(error.issues.some((issue) => issue.startsWith("PORT:"))).toBe(true);
    expect(error.issues.some((issue) => issue.startsWith("LOG_LEVEL:"))).toBe(true);
  });

  it("never includes rejected values in the error message", () => {
    const secret = "s3cr3t-value-that-must-not-be-logged";
    const error = captureError(() => loadApiConfig({ LOG_LEVEL: secret, PORT: secret }));
    if (!(error instanceof ConfigError)) {
      throw new Error("expected a ConfigError");
    }
    expect(error.message).not.toContain(secret);
  });
});
