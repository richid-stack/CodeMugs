import { ConfigError } from "@codemugs/configuration";
import { superviseWorker } from "@codemugs/jobs";
import { createLogger, describeFatal } from "@codemugs/logging";
import { takeConfig } from "./environment.js";
import { startAnalysisWorker } from "./start.js";

async function main(): Promise<void> {
  let config;
  try {
    config = takeConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Safe to print: the message names variables and never contains a value.
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const logger = createLogger(config.logLevel);
  await superviseWorker({
    logger,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    start: () => startAnalysisWorker({ config, logger }),
  });
}

main().catch((error: unknown) => {
  // Not the error itself: it could hold a connection string or a message from the database.
  console.error("failed to start", describeFatal(error));
  process.exit(1);
});
