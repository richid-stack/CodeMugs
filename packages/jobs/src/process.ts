import { describeFatal, type Logger } from "@codemugs/logging";
import { WorkerStartupError } from "./preflight.js";

/** A worker that is running: how to stop it, and when it has. */
export interface WorkerHandle {
  /**
   * Stops taking jobs, waits for the ones in progress and closes the database connections.
   * Safe to call more than once. Rejects if the worker had already failed.
   */
  stop(): Promise<void>;
  /** Settles when the worker has stopped, and rejects if it stopped because of a failure. */
  finished: Promise<void>;
}

export interface SuperviseOptions {
  readonly logger: Logger;
  /** How long a stop request may take, from the signal, whatever the process is doing by then. */
  readonly shutdownTimeoutMs: number;
  /**
   * Connects, checks and starts taking jobs. A {@link WorkerStartupError} is a refusal to start and is
   * logged as one; anything else is thrown to the caller, which says that the start failed.
   */
  readonly start: () => Promise<WorkerHandle>;
}

/**
 * Runs a worker as the program: handles the signals that ask it to stop, starts it, and waits until
 * it has stopped. It sets `process.exitCode` to 1 when the worker could not start, stopped by itself
 * or could not be stopped in time, and returns when the program may end.
 *
 * What it keeps the same for every worker process:
 *
 * - Signals are handled from the start, while the worker is still connecting. The time allowed for
 *   stopping begins with the first signal and covers the startup checks too, which can wait on a
 *   database that does not answer. Until the worker is running there is nothing to stop, so the
 *   stop is remembered and carried out as soon as it is. Left to the default action, a signal would
 *   end the program in the middle of connecting, and a program that is told to stop must end by
 *   saying that it did.
 * - A job still running when the time is up is abandoned. Its transaction ends with the connection,
 *   and another worker takes it when its lease runs out.
 * - A process in an unknown state (an exception no one caught) should die and be restarted by the
 *   orchestrator.
 */
export async function superviseWorker(options: SuperviseOptions): Promise<void> {
  const { logger } = options;

  let running: WorkerHandle | undefined;
  let shuttingDown = false;
  const stop = async (handle: WorkerHandle): Promise<void> => {
    try {
      await handle.stop();
      logger.info("shutdown complete");
    } catch (error) {
      logger.error("error during shutdown", describeFatal(error));
      process.exitCode = 1;
    }
  };

  // `once` so a second Ctrl-C during a slow drain falls through to the default (terminate).
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info("shutdown requested", { signal });

      const forceExit = setTimeout(() => {
        logger.error(
          running === undefined
            ? "graceful shutdown timed out before the worker had started"
            : "graceful shutdown timed out; exiting with jobs in progress",
        );
        process.exit(1);
      }, options.shutdownTimeoutMs);
      forceExit.unref();

      if (running !== undefined) void stop(running);
    });
  }

  // After the handlers are in, so that whoever waits for this line to send a signal gets the stop
  // that it asked for and not the default action.
  logger.info("worker starting");

  let worker: WorkerHandle;
  try {
    worker = await options.start();
    running = worker;
  } catch (error) {
    if (error instanceof WorkerStartupError) {
      // Safe to print: it names the variable and what is wrong, and nothing the database said.
      // The code is one of the process's own, so it is read as a string here.
      const { code, variable } = error as WorkerStartupError<string>;
      logger.fatal(error.message, { code, variable });
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  // Told to stop while it was starting: nothing ran in between, so this is the first stop.
  if (shuttingDown) void stop(worker);

  process.on("uncaughtException", (error) => {
    logger.fatal("uncaught exception", describeFatal(error));
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal("unhandled rejection", describeFatal(reason));
    process.exit(1);
  });

  // The worker only stops by itself if it failed. Stopping on request is handled above.
  try {
    await worker.finished;
  } catch (error) {
    if (!shuttingDown) {
      logger.fatal("worker stopped unexpectedly", describeFatal(error));
      process.exitCode = 1;
    }
  }
}
