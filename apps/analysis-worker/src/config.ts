import { isAbsolute } from "node:path";
import { ANALYSIS_SANDBOX } from "@codemugs/application-intelligence";
import {
  ConfigError,
  logLevelSetting,
  parseEnv,
  requiredPostgresUrl,
  Secret,
  type Env,
} from "@codemugs/configuration";
import { loadGitHubAppCredentials, type GitHubAppCredentials } from "@codemugs/github";
import { IMAGE_BY_DIGEST, isolationAtLeast, type IsolationLevel } from "@codemugs/sandbox-manager";
import { z } from "zod";

/**
 * How long each outside step of an analysis may take, as the process sets them on its GitHub client.
 * The lease is worked out from these and from the sandbox's limit, so they are written here and not
 * left to the client's defaults.
 */
export const ANALYSIS_TIMING = Object.freeze({
  /** One request to GitHub's API. */
  githubRequestMs: 30_000,
  /** The download of the archive, from the request that follows the redirect to its end. */
  githubDownloadMs: 120_000,
});

/**
 * The longest that one try of the job can take, in seconds. A try asks GitHub for a token, for the
 * commit and for the archive (three requests, each up to {@link ANALYSIS_TIMING.githubRequestMs}),
 * downloads it (the unpacking goes on as it arrives), runs the analysis in the sandbox for at most
 * its wall-clock limit, and stores the result. The last allowance covers what has no limit of its
 * own: copying the working copy in, starting and removing the container, and the write. It is an
 * estimate that has not been measured on a large repository.
 *
 * The lease must be longer than this, because the work is checked against the lease between its
 * steps and not inside them, and nothing extends it (ADR 0030, ADR 0032 decision 6). A lease that is
 * shorter would let another worker take a job that is still running.
 */
export const LONGEST_ANALYSIS_SECONDS =
  Math.ceil((3 * ANALYSIS_TIMING.githubRequestMs + ANALYSIS_TIMING.githubDownloadMs) / 1_000) +
  ANALYSIS_SANDBOX.limits.wallClockSeconds +
  60;

/** The drivers that can be chosen, and how much each isolates. */
export const SANDBOX_DRIVERS = Object.freeze({
  docker: "hardened-container",
  gvisor: "gvisor",
} as const satisfies Record<string, IsolationLevel>);

export type SandboxDriverName = keyof typeof SANDBOX_DRIVERS;

const DRIVER_NAMES = Object.keys(SANDBOX_DRIVERS) as [SandboxDriverName, ...SandboxDriverName[]];

const ISOLATION_LEVELS = ["hardened-container", "gvisor", "microvm"] as const satisfies readonly [
  IsolationLevel,
  ...IsolationLevel[],
];

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: logLevelSetting,
    // A job still running when this passes is abandoned, and another worker takes it when its lease
    // runs out. An analysis can take minutes, so most of them are not finished by it.
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
    DATABASE_URL: requiredPostgresUrl,
    DISPATCHER_DATABASE_URL: requiredPostgresUrl,
    // One by default: each analysis holds a sandbox of 1 CPU and 1 GiB, and the host unpacks beside it.
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(1_000),
    WORKER_LEASE_SECONDS: z.coerce
      .number()
      .int()
      .min(
        LONGEST_ANALYSIS_SECONDS,
        `must be at least ${String(LONGEST_ANALYSIS_SECONDS)}, which is longer than the longest analysis takes`,
      )
      .max(86_400)
      .default(600),
    // The sandbox is chosen, never defaulted: what a repository may be run on is for the operator to
    // say (ADR 0007 decision 5).
    ANALYSIS_SANDBOX_DRIVER: z.enum(DRIVER_NAMES, {
      error: `is required, and must be one of: ${DRIVER_NAMES.join(", ")}`,
    }),
    ANALYSIS_SANDBOX_MINIMUM_ISOLATION: z.enum(ISOLATION_LEVELS, {
      error: `is required, and must be one of: ${ISOLATION_LEVELS.join(", ")}`,
    }),
    ANALYSIS_SANDBOX_IMAGE: z
      .string({ error: "is required" })
      .regex(IMAGE_BY_DIGEST, "must be pinned by digest: name@sha256:<64 hex digits>"),
    // Where the working copies are made, and the only place the driver will mount from.
    ANALYSIS_WORKSPACE_ROOT: z
      .string({ error: "is required" })
      .refine(
        (value) => isAbsolute(value) && !value.includes("\0"),
        "must be an absolute path to a folder",
      ),
  })
  .refine((env) => env.DATABASE_URL !== env.DISPATCHER_DATABASE_URL, {
    path: ["DISPATCHER_DATABASE_URL"],
    message: "must not be the same as DATABASE_URL: they are different roles",
  })
  .refine(
    (env) =>
      isolationAtLeast(
        SANDBOX_DRIVERS[env.ANALYSIS_SANDBOX_DRIVER],
        env.ANALYSIS_SANDBOX_MINIMUM_ISOLATION,
      ),
    {
      path: ["ANALYSIS_SANDBOX_MINIMUM_ISOLATION"],
      message:
        "is more than the chosen ANALYSIS_SANDBOX_DRIVER gives: every analysis would be refused",
    },
  )
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
    sandbox: {
      driver: env.ANALYSIS_SANDBOX_DRIVER,
      minimumIsolation: env.ANALYSIS_SANDBOX_MINIMUM_ISOLATION,
      image: env.ANALYSIS_SANDBOX_IMAGE,
      workspaceRoot: env.ANALYSIS_WORKSPACE_ROOT,
    },
  }));

export type AnalysisWorkerConfig = z.output<typeof schema> & {
  /** The GitHub App's own settings. The key is a {@link Secret}. */
  readonly github: GitHubAppCredentials;
};

function attempt<T>(work: () => T, issues: string[]): T | undefined {
  try {
    return work();
  } catch (error) {
    if (error instanceof ConfigError) {
      issues.push(...error.issues);
      return undefined;
    }
    throw error;
  }
}

/**
 * The settings of the process that analyses repositories, from the environment. Everything that is
 * wrong is named at once, by variable and never by value, so that an operator mends the environment
 * in one go. The database addresses and the GitHub key are {@link Secret}s.
 *
 * It refuses what could only fail later and every time: a lease that is shorter than an analysis can
 * be, an isolation that the chosen driver cannot give, and an image that is not pinned by digest.
 */
export function loadAnalysisWorkerConfig(env: Env = process.env): AnalysisWorkerConfig {
  const issues: string[] = [];
  const own = attempt(() => parseEnv(schema, env), issues);
  const github = attempt(() => loadGitHubAppCredentials(env), issues);
  if (own === undefined || github === undefined) throw new ConfigError(issues);
  return { ...own, github };
}
