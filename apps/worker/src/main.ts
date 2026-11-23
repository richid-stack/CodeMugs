import { ConfigError, loadWorkerConfig } from "@codemugs/configuration";
import { superviseWorker } from "@codemugs/jobs";
import { createLogger, describeFatal } from "@codemugs/logging";
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
  // Signals, the time allowed for stopping and what happens when the worker fails are the same for
  // every worker process, and are in the jobs library.
  await superviseWorker({
    logger,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    start: () => startWorker({ config, logger }),
  });
}

main().catch((error: unknown) => {
  // Not the error itself: it could hold a connection string or a message from the database.
  console.error("failed to start", describeFatal(error));
  process.exit(1);
});
