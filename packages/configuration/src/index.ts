import { z } from "zod";

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
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    bodyLimitBytes: env.BODY_LIMIT_BYTES,
  }));

export type ApiConfig = z.output<typeof apiEnvSchema>;

export function loadApiConfig(env: Env = process.env): ApiConfig {
  return parseEnv(apiEnvSchema, env);
}
