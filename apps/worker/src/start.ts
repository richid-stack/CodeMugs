import type { WorkerConfig } from "@codemugs/configuration";
import { runWorker, type JobHandler } from "@codemugs/jobs";
import { createPool } from "@codemugs/storage";
import { logWorkerEvent } from "./events.js";
import { handlers as registeredHandlers } from "./handlers.js";
import { describeFailure, type Logger } from "@codemugs/logging";
import { verifyDatabase } from "./preflight.js";

/** What the worker's connections are called in `pg_stat_activity`. */
export const APPLICATION_NAME = "codemugs-worker";

export interface WorkerHandle {
  /**
   * Stops taking jobs, waits for the ones in progress and closes the database connections.
   * Safe to call more than once. Rejects if the worker had already failed.
   */
  stop(): Promise<void>;
  /** Settles when the worker has stopped, and rejects if it stopped because of a failure. */
  finished: Promise<void>;
}

export interface StartOptions {
  config: WorkerConfig;
  logger: Logger;
  /** For tests. Defaults to the handlers this process is built to run. */
  handlers?: Readonly<Record<string, JobHandler>>;
  /** For tests. Defaults to the checks of the database role contract. */
  verify?: typeof verifyDatabase;
}

/**
 * Connects to the database as the two roles, checks them, and starts taking jobs. Throws a
 * `WorkerStartupError` without taking any if the connections are not what they should be.
 */
export async function startWorker(options: StartOptions): Promise<WorkerHandle> {
  const { config, logger } = options;
  const handlers = options.handlers ?? registeredHandlers;
  const verify = options.verify ?? verifyDatabase;

  const onError = (error: Error): void => {
    logger.error("database connection error", { code: describeFailure(error) });
  };
  // Every job in progress holds a connection, so the application pool is as large as the
  // concurrency. Finding work is one query at a time.
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
    await verify({ app, dispatcher });
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
  });

  return {
    stop: () => {
      controller.abort();
      return finished;
    },
    finished,
  };
}
