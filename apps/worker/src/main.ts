import { ConfigError, loadWorkerConfig } from "@codemugs/configuration";
import { describeFatal } from "./fatal.js";
import { createLogger } from "./logger.js";
import { WorkerStartupError } from "./preflight.js";
import { startWorker } from "./start.js";

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

  let worker;
  try {
    worker = await startWorker({ config, logger });
  } catch (error) {
    if (error instanceof WorkerStartupError) {
      // Safe to print: it names the variable and what is wrong, and nothing the database said.
      logger.fatal(error.message, { code: error.code, variable: error.variable });
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown requested", { signal });

    // A job still running when the time is up is abandoned. Its transaction ends with the
    // connection, and another worker takes it when its lease runs out.
    const forceExit = setTimeout(() => {
      logger.error("graceful shutdown timed out; exiting with jobs in progress");
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExit.unref();

    try {
      await worker.stop();
      logger.info("shutdown complete");
    } catch (error) {
      logger.error("error during shutdown", describeFatal(error));
      process.exitCode = 1;
    }
  };

  // `once` so a second Ctrl-C during a slow drain falls through to the default (terminate).
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

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
