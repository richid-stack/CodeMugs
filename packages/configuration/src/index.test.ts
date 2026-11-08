import { format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, loadApiConfig, Secret } from "./index.js";

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
      databaseUrl: undefined,
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

describe("DATABASE_URL", () => {
  const url = "postgres://app_user:p4ssw0rd-that-must-stay-hidden@db.internal:5432/codemugs";

  it("is optional outside production", () => {
    expect(loadApiConfig({ NODE_ENV: "development" }).databaseUrl).toBeUndefined();
    expect(loadApiConfig({ NODE_ENV: "test" }).databaseUrl).toBeUndefined();
  });

  it("treats an empty value as unset", () => {
    expect(loadApiConfig({ DATABASE_URL: "" }).databaseUrl).toBeUndefined();
  });

  it("is required in production, and the error names the variable", () => {
    for (const env of [{ NODE_ENV: "production" }, { NODE_ENV: "production", DATABASE_URL: "" }]) {
      const error = captureError(() => loadApiConfig(env));
      if (!(error instanceof ConfigError)) throw new Error("expected a ConfigError");
      expect(error.issues).toEqual(["DATABASE_URL: is required when NODE_ENV is production"]);
    }
  });

  it("accepts postgres:// and postgresql:// URLs", () => {
    for (const accepted of [url, url.replace("postgres://", "postgresql://")]) {
      expect(loadApiConfig({ DATABASE_URL: accepted }).databaseUrl?.reveal()).toBe(accepted);
    }
  });

  it("rejects anything else without echoing the value", () => {
    const rejected = "mysql://user:p4ssw0rd-that-must-stay-hidden@host/db";
    const error = captureError(() => loadApiConfig({ DATABASE_URL: rejected }));
    if (!(error instanceof ConfigError)) throw new Error("expected a ConfigError");
    expect(error.issues).toEqual(["DATABASE_URL: must be a postgres:// or postgresql:// URL"]);
    expect(error.message).not.toContain("p4ssw0rd");
    expect(error.message).not.toContain("mysql");
  });

  it("cannot be revealed by logging or serialising the whole configuration", () => {
    const config = loadApiConfig({ DATABASE_URL: url });
    const everyWayToPrintIt = [
      JSON.stringify(config),
      String(config.databaseUrl),
      `${String(config.databaseUrl)}`,
      inspect(config),
      inspect(config, { showHidden: true, depth: 10 }),
      format("%s %j %o %O", config.databaseUrl, config.databaseUrl, config, config),
      JSON.stringify({ nested: { value: config.databaseUrl } }),
      Object.keys(config.databaseUrl ?? {}).join(","),
      // A structured clone drops private fields, so a copy carries no value either.
      JSON.stringify(structuredClone(config.databaseUrl)),
    ].join("\n");
    expect(everyWayToPrintIt).not.toContain("p4ssw0rd");
    expect(everyWayToPrintIt).not.toContain("db.internal");
    expect(everyWayToPrintIt).toContain("[redacted]");
  });
});

describe("Secret", () => {
  it("returns the value only through reveal()", () => {
    const secret = new Secret("value-123");
    expect(secret.reveal()).toBe("value-123");
    expect(secret.toString()).toBe("[redacted]");
    expect(secret.toJSON()).toBe("[redacted]");
  });
});
