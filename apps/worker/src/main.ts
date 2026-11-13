import { ConfigError, loadWorkerConfig } from "@codemugs/configuration";
import { createLogger, describeFatal } from "@codemugs/logging";
import { WorkerStartupError } from "./preflight.js";
import { startWorker, type WorkerHandle } from "./start.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadWorkerConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Safe to print: the message never contains rejected values.
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const logger = createLogger(config.logLevel);

  // Signals are handled from here on, while the worker is still connecting. The time allowed for
  // stopping starts with the first signal, not when the worker is running: it covers the startup
  // checks too, which can wait on a database that does not answer. Until the worker is running there
  // is nothing to stop, so the stop is remembered and carried out as soon as it is. Left to the
  // default action, a signal would end the program in the middle of connecting, and a program that
  // is told to stop must end by saying that it did.
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

      // A job still running when the time is up is abandoned. Its transaction ends with the
      // connection, and another worker takes it when its lease runs out.
      const forceExit = setTimeout(() => {
        logger.error(
          running === undefined
            ? "graceful shutdown timed out before the worker had started"
            : "graceful shutdown timed out; exiting with jobs in progress",
        );
        process.exit(1);
      }, config.shutdownTimeoutMs);
      forceExit.unref();

      if (running !== undefined) void stop(running);
    });
  }

  // After the handlers are in, so that whoever waits for this line to send a signal gets the stop
  // that it asked for and not the default action.
  logger.info("worker starting");

  let worker: WorkerHandle;
  try {
    worker = await startWorker({ config, logger });
    running = worker;
  } catch (error) {
    if (error instanceof WorkerStartupError) {
      // Safe to print: it names the variable and what is wrong, and nothing the database said.
      logger.fatal(error.message, { code: error.code, variable: error.variable });
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  // Told to stop while it was starting: nothing ran in between, so this is the first stop.
  if (shuttingDown) void stop(worker);

  // A process in an unknown state should die and be restarted by the orchestrator.
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

main().catch((error: unknown) => {
  // Not the error itself: it could hold a connection string or a message from the database.
  console.error("failed to start", describeFatal(error));
  process.exit(1);
});
