import { ConfigError, loadMigrationConfig } from "@codemugs/configuration";
import { createLogger, describeFatal } from "@codemugs/logging";
import { migrate } from "./migrate.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadMigrationConfig();
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

  // Ending the process drops the database connection, which rolls back the migration in
  // progress. Each migration is its own transaction, so the ones that finished stay applied and
  // the next run takes up from there.
  const giveUp = setTimeout(() => {
    logger.fatal("the migrations did not finish in time; exiting", {
      code: "timeout",
      timeoutMs: config.timeoutMs,
    });
    process.exit(1);
  }, config.timeoutMs);
  giveUp.unref();

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      logger.error("interrupted; the migration in progress is rolled back", {
        code: "interrupted",
        signal,
      });
      process.exit(1);
    });
  }

  const result = await migrate({ config, logger });
  clearTimeout(giveUp);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  // Not the error itself: it could hold a connection string or a message from the database.
  console.error("the migration command failed", describeFatal(error));
  process.exit(1);
});
