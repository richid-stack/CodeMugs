import { format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  loadApiConfig,
  loadMigrationConfig,
  loadWorkerConfig,
  Secret,
} from "./index.js";

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

describe("loadWorkerConfig", () => {
  const app =
    "postgres://codemugs_app:app-password-that-must-stay-hidden@db.internal:5432/codemugs";
  const dispatcher =
    "postgres://codemugs_dispatcher:dispatcher-password-that-must-stay-hidden@db.internal:5432/codemugs";
  const required = { DATABASE_URL: app, DISPATCHER_DATABASE_URL: dispatcher };

  function issuesOf(env: Record<string, string | undefined>): readonly string[] {
    const error = captureError(() => loadWorkerConfig(env));
    if (!(error instanceof ConfigError)) throw new Error("expected a ConfigError");
    return error.issues;
  }

  it("applies defaults for everything but the two connections", () => {
    const config = loadWorkerConfig(required);
    expect(config).toMatchObject({
      nodeEnv: "development",
      logLevel: "info",
      shutdownTimeoutMs: 30_000,
      concurrency: 4,
      pollIntervalMs: 1_000,
      leaseSeconds: 60,
    });
    expect(config.databaseUrl.reveal()).toBe(app);
    expect(config.dispatcherDatabaseUrl.reveal()).toBe(dispatcher);
  });

  it("reads the tuning variables as numbers", () => {
    const config = loadWorkerConfig({
      ...required,
      WORKER_CONCURRENCY: "8",
      WORKER_POLL_INTERVAL_MS: "250",
      WORKER_LEASE_SECONDS: "120",
      SHUTDOWN_TIMEOUT_MS: "5000",
    });
    expect(config).toMatchObject({
      concurrency: 8,
      pollIntervalMs: 250,
      leaseSeconds: 120,
      shutdownTimeoutMs: 5_000,
    });
  });

  it("requires both connections, in every environment, and names them", () => {
    for (const nodeEnv of ["development", "test", "production"]) {
      const issues = issuesOf({ NODE_ENV: nodeEnv });
      expect(issues.some((issue) => issue.startsWith("DATABASE_URL:"))).toBe(true);
      expect(issues.some((issue) => issue.startsWith("DISPATCHER_DATABASE_URL:"))).toBe(true);
    }
    expect(issuesOf({ DATABASE_URL: app }).join("\n")).toContain("DISPATCHER_DATABASE_URL");
    expect(issuesOf({ DISPATCHER_DATABASE_URL: dispatcher }).join("\n")).toContain("DATABASE_URL");
  });

  it("treats an empty connection string as missing", () => {
    const issues = issuesOf({ DATABASE_URL: "", DISPATCHER_DATABASE_URL: dispatcher });
    expect(issues).toContain("DATABASE_URL: is required");
  });

  it("refuses the same connection for both roles", () => {
    const issues = issuesOf({ DATABASE_URL: app, DISPATCHER_DATABASE_URL: app });
    expect(issues.some((issue) => issue.startsWith("DISPATCHER_DATABASE_URL:"))).toBe(true);
  });

  it("rejects out-of-range tuning values", () => {
    const issues = issuesOf({
      ...required,
      WORKER_CONCURRENCY: "0",
      WORKER_POLL_INTERVAL_MS: "5",
      WORKER_LEASE_SECONDS: "0",
    });
    for (const name of ["WORKER_CONCURRENCY", "WORKER_POLL_INTERVAL_MS", "WORKER_LEASE_SECONDS"]) {
      expect(issues.some((issue) => issue.startsWith(`${name}:`))).toBe(true);
    }
    expect(issuesOf({ ...required, WORKER_CONCURRENCY: "101" })[0]).toMatch(/^WORKER_CONCURRENCY:/);
    expect(issuesOf({ ...required, WORKER_LEASE_SECONDS: "86401" })[0]).toMatch(
      /^WORKER_LEASE_SECONDS:/,
    );
  });

  it("never puts a rejected value, or either password, in the error", () => {
    const bad = "mysql://root:root-password-that-must-stay-hidden@db.internal/codemugs";
    const error = captureError(() =>
      loadWorkerConfig({ DATABASE_URL: bad, DISPATCHER_DATABASE_URL: bad, LOG_LEVEL: bad }),
    );
    if (!(error instanceof ConfigError)) throw new Error("expected a ConfigError");
    expect(error.message).not.toContain("root-password");
    expect(error.message).not.toContain(bad);

    const same = captureError(() =>
      loadWorkerConfig({ DATABASE_URL: app, DISPATCHER_DATABASE_URL: app }),
    );
    if (!(same instanceof ConfigError)) throw new Error("expected a ConfigError");
    expect(same.message).not.toContain("app-password");
  });

  it("keeps both connection strings out of anything that prints the configuration", () => {
    const config = loadWorkerConfig(required);
    for (const text of [
      JSON.stringify(config),
      inspect(config, { depth: 5 }),
      format("%o", config),
    ]) {
      expect(text).not.toContain("app-password-that-must-stay-hidden");
      expect(text).not.toContain("dispatcher-password-that-must-stay-hidden");
    }
  });
});

describe("loadMigrationConfig", () => {
  const url =
    "postgres://codemugs:migration-password-that-must-stay-hidden@db.internal:5432/codemugs";

  function issuesOf(env: Record<string, string | undefined>): readonly string[] {
    const error = captureError(() => loadMigrationConfig(env));
    if (!(error instanceof ConfigError)) throw new Error("expected a ConfigError");
    return error.issues;
  }

  it("needs the migration connection, in every environment, and applies defaults", () => {
    for (const nodeEnv of ["development", "test", "production"]) {
      expect(issuesOf({ NODE_ENV: nodeEnv })).toContain("MIGRATION_DATABASE_URL: is required");
    }
    const config = loadMigrationConfig({ MIGRATION_DATABASE_URL: url });
    expect(config).toMatchObject({ nodeEnv: "development", logLevel: "info", timeoutMs: 600_000 });
    expect(config.databaseUrl.reveal()).toBe(url);
  });

  it("does not take the application's connection variable for it", () => {
    expect(issuesOf({ DATABASE_URL: url })).toContain("MIGRATION_DATABASE_URL: is required");
  });

  it("treats an empty connection string as missing", () => {
    expect(issuesOf({ MIGRATION_DATABASE_URL: "" })).toContain(
      "MIGRATION_DATABASE_URL: is required",
    );
  });

  it("bounds the timeout", () => {
    expect(
      loadMigrationConfig({ MIGRATION_DATABASE_URL: url, MIGRATION_TIMEOUT_MS: "5000" }),
    ).toMatchObject({
      timeoutMs: 5_000,
    });
    for (const timeout of ["999", "3600001", "0", "-1", "soon", "1500.5"]) {
      const issues = issuesOf({ MIGRATION_DATABASE_URL: url, MIGRATION_TIMEOUT_MS: timeout });
      expect(issues.some((issue) => issue.startsWith("MIGRATION_TIMEOUT_MS:"))).toBe(true);
    }
  });

  it("takes only the log levels it knows", () => {
    expect(loadMigrationConfig({ MIGRATION_DATABASE_URL: url, LOG_LEVEL: "error" }).logLevel).toBe(
      "error",
    );
    const issues = issuesOf({ MIGRATION_DATABASE_URL: url, LOG_LEVEL: "loud" });
    expect(issues.some((issue) => issue.startsWith("LOG_LEVEL:"))).toBe(true);
  });

  it("never puts a rejected value or the password in the error, or in a printed configuration", () => {
    const bad = "mysql://root:root-password-that-must-stay-hidden@db.internal/codemugs";
    const error = captureError(() => loadMigrationConfig({ MIGRATION_DATABASE_URL: bad }));
    if (!(error instanceof ConfigError)) throw new Error("expected a ConfigError");
    expect(error.message).not.toContain("root-password");
    expect(error.message).not.toContain(bad);

    const config = loadMigrationConfig({ MIGRATION_DATABASE_URL: url });
    for (const text of [
      JSON.stringify(config),
      inspect(config, { depth: 5 }),
      format("%o", config),
    ]) {
      expect(text).not.toContain("migration-password-that-must-stay-hidden");
    }
  });
});
