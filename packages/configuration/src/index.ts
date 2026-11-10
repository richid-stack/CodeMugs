import { z } from "zod";
import { Secret } from "./secret.js";

export { Secret } from "./secret.js";

/**
 * Thrown when environment configuration is invalid.
 *
 * The message names the offending variables and why they were rejected, but never
 * includes the rejected values themselves, so secrets cannot leak into logs.
 */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export type Env = Record<string, string | undefined>;

/** Validate an environment object against a schema, failing fast with a {@link ConfigError}. */
export function parseEnv<TSchema extends z.ZodType>(
  schema: TSchema,
  env: Env = process.env,
): z.output<TSchema> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map(
        (issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}

const apiEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // Loopback by default; containers set HOST=0.0.0.0 explicitly.
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
    // Connection string for the restricted application role (never the migration role). An
    // empty value counts as unset. The messages below never include the value.
    DATABASE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// URL")
        .optional(),
    ),
  })
  .refine((env) => env.NODE_ENV !== "production" || env.DATABASE_URL !== undefined, {
    path: ["DATABASE_URL"],
    message: "is required when NODE_ENV is production",
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    bodyLimitBytes: env.BODY_LIMIT_BYTES,
    /** Wrapped so logging the whole configuration cannot reveal it. Call `reveal()` to use it. */
    databaseUrl: env.DATABASE_URL === undefined ? undefined : new Secret(env.DATABASE_URL),
  }));

export type ApiConfig = z.output<typeof apiEnvSchema>;

export function loadApiConfig(env: Env = process.env): ApiConfig {
  return parseEnv(apiEnvSchema, env);
}

/** A connection string that is required: unset and empty both count as missing. */
const requiredPostgresUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string({ error: "is required" })
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// URL"),
);

const workerEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    // Jobs in progress get this long to finish after a stop request. One that is still running
    // is abandoned, and another worker takes it when its lease runs out.
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
    // The application role, as for the API. Handlers run in tenant transactions on this one.
    DATABASE_URL: requiredPostgresUrl,
    // The dispatcher role (ADR 0012): finds due jobs in any tenant and can do nothing else. It
    // must not be the same login as DATABASE_URL.
    DISPATCHER_DATABASE_URL: requiredPostgresUrl,
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(1_000),
    WORKER_LEASE_SECONDS: z.coerce.number().int().min(1).max(86_400).default(60),
  })
  .refine((env) => env.DATABASE_URL !== env.DISPATCHER_DATABASE_URL, {
    path: ["DISPATCHER_DATABASE_URL"],
    message: "must not be the same as DATABASE_URL: they are different roles",
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    /** Wrapped so logging the whole configuration cannot reveal it. Call `reveal()` to use it. */
    databaseUrl: new Secret(env.DATABASE_URL),
    dispatcherDatabaseUrl: new Secret(env.DISPATCHER_DATABASE_URL),
    concurrency: env.WORKER_CONCURRENCY,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    leaseSeconds: env.WORKER_LEASE_SECONDS,
  }));

export type WorkerConfig = z.output<typeof workerEnvSchema>;

export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  return parseEnv(workerEnvSchema, env);
}
