import {
  analyseArchive,
  type ArchiveSink,
  type RepositoryFacts,
} from "@codemugs/application-intelligence";
import { GitHubApp } from "@codemugs/github";
import { logWorkerEvent, runWorker, type WorkerHandle } from "@codemugs/jobs";
import { describeFailure, type Logger } from "@codemugs/logging";
import {
  createDockerDriver,
  createGvisorDriver,
  type SandboxDriver,
} from "@codemugs/sandbox-manager";
import { createPool } from "@codemugs/storage";
import {
  analysisHandlers,
  githubRepositories,
  type AnalyseJobDependencies,
} from "./analyse-job.js";
import { ANALYSIS_TIMING, type AnalysisWorkerConfig, type SandboxDriverName } from "./config.js";
import { verifyAnalysisDatabase, verifyGitHubKey, verifySandbox } from "./preflight.js";

/** What the process's connections are called in `pg_stat_activity`. */
export const APPLICATION_NAME = "codemugs-analysis-worker";

export type { WorkerHandle };

/** The driver that the configuration names, for the folder that it keeps working copies in. */
export function createSandboxDriver(name: SandboxDriverName, workspaceRoot: string): SandboxDriver {
  return name === "gvisor"
    ? createGvisorDriver({ workspaceRoot })
    : createDockerDriver({ workspaceRoot });
}

export interface StartOptions {
  config: AnalysisWorkerConfig;
  logger: Logger;
  /** For tests. Defaults to the GitHub App that the configuration holds the key of. */
  openRepository?: AnalyseJobDependencies["openRepository"];
  /** For tests. Defaults to the driver that the configuration names. */
  driver?: SandboxDriver;
  /** For tests. Defaults to the checks of the database role contract and of the job's tables. */
  verifyDatabase?: typeof verifyAnalysisDatabase;
  /** For tests. Defaults to the checks of the folder, the driver and the image. */
  verifySandbox?: typeof verifySandbox;
}

/**
 * Checks everything that the process needs and starts taking `repository.analyse` jobs. Throws a
 * `WorkerStartupError` without taking any if one of these is not as it should be: the key of the
 * GitHub App, the two database connections and the tables of the job, the folder for working copies,
 * and the sandbox (it must be there, isolate at least as much as the configuration says, and run the
 * image). Nothing is read from GitHub and nothing of a customer's runs while it checks.
 *
 * The process is the only place that holds the GitHub App's key and the one that runs the analysis,
 * and it holds nothing the API holds (ADR 0031, ADR 0035).
 */
export async function startAnalysisWorker(options: StartOptions): Promise<WorkerHandle> {
  const { config, logger } = options;
  const { driver: driverName, image, minimumIsolation, workspaceRoot } = config.sandbox;
  const driver = options.driver ?? createSandboxDriver(driverName, workspaceRoot);
  const verifyDatabase = options.verifyDatabase ?? verifyAnalysisDatabase;
  const checkSandbox = options.verifySandbox ?? verifySandbox;

  // The key first: it needs nothing outside the process, and a key that cannot sign fails the same
  // way every time.
  verifyGitHubKey(config.github);

  const openRepository =
    options.openRepository ??
    githubRepositories(
      new GitHubApp(
        { clientId: config.github.clientId, privateKey: config.github.privateKey },
        {
          // The lease is worked out from these (see `LONGEST_ANALYSIS_SECONDS`).
          timeoutMs: ANALYSIS_TIMING.githubRequestMs,
          downloadTimeoutMs: ANALYSIS_TIMING.githubDownloadMs,
        },
      ),
    );

  const handlers = analysisHandlers({
    openRepository,
    analyse: (archive: (sink: ArchiveSink) => Promise<unknown>): Promise<RepositoryFacts> =>
      analyseArchive({ archive, driver, workspaceRoot, image, minimumIsolation }),
  });

  const onError = (error: Error): void => {
    logger.error("database connection error", { code: describeFailure(error) });
  };
  // A job holds a connection only while it reads its plan and while it stores the run: the
  // download and the analysis hold none (ADR 0030). One for each job in progress is still enough.
  const app = createPool({
    connectionString: config.databaseUrl.reveal(),
    maxConnections: config.concurrency,
    applicationName: APPLICATION_NAME,
    onError,
  });
  const dispatcher = createPool({
    connectionString: config.dispatcherDatabaseUrl.reveal(),
    maxConnections: 2,
    applicationName: APPLICATION_NAME,
    onError,
  });
  const closePools = (): Promise<unknown> => Promise.allSettled([app.end(), dispatcher.end()]);

  try {
    await verifyDatabase({ app, dispatcher });
    await checkSandbox({ driver, minimumIsolation, image, workspaceRoot });
  } catch (error) {
    await closePools();
    throw error;
  }

  const controller = new AbortController();
  const finished = runWorker({
    dispatcher,
    app,
    handlers,
    signal: controller.signal,
    concurrency: config.concurrency,
    pollIntervalMs: config.pollIntervalMs,
    leaseSeconds: config.leaseSeconds,
    onEvent: (event) => {
      logWorkerEvent(logger, event);
    },
  }).finally(closePools);
  // Reported by whoever awaits `finished` or `stop`; without this a failure before anyone awaits
  // would be an unhandled rejection.
  finished.catch(() => undefined);

  logger.info("worker started", {
    kinds: Object.keys(handlers).join(","),
    concurrency: config.concurrency,
    pollIntervalMs: config.pollIntervalMs,
    leaseSeconds: config.leaseSeconds,
    sandbox: driver.name,
    isolation: driver.isolation,
    minimumIsolation,
  });

  return {
    stop: () => {
      controller.abort();
      return finished;
    },
    finished,
  };
}
