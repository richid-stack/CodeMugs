import { ConfigError, loadApiConfig } from "@codemugs/configuration";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadApiConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Safe to print: the message never contains rejected values.
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const { app, health } = await buildApp({ config });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutdown requested");

    // Fail readiness first so load balancers stop sending new traffic, then drain.
    health.shuttingDown = true;

    const forceExit = setTimeout(() => {
      app.log.error("graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExit.unref();

    try {
      await app.close();
      app.log.info("shutdown complete");
    } catch (error) {
      app.log.error({ err: error }, "error during shutdown");
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
    app.log.fatal({ err: error }, "uncaught exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    app.log.fatal({ err: reason }, "unhandled rejection");
    process.exit(1);
  });

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  console.error("failed to start", error);
  process.exit(1);
});
