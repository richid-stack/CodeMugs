import { Pool } from "pg";

export interface PoolOptions {
  /** Connection string for the application role. Never the migration role. */
  connectionString: string;
  maxConnections?: number;
  /**
   * How long to wait to get a connection, whether from the pool or by opening a new one, before
   * failing. Default 5 seconds. Without a limit, an unresponsive database host would make every
   * request wait for the operating system's own TCP timeout.
   */
  connectionTimeoutMs?: number;
  /** Cancels any single statement that runs longer than this. Default 30 seconds. */
  statementTimeoutMs?: number;
  /** Ends sessions that sit idle inside a transaction. Default 30 seconds. */
  idleInTransactionTimeoutMs?: number;
  /**
   * Shown as `application_name` in `pg_stat_activity`, so an operator can tell which process a
   * connection belongs to. A short fixed name, never a value from a request.
   */
  applicationName?: string;
  /** Called when an idle connection fails, for example when the database restarts. */
  onError?: (error: Error) => void;
}

export function createPool(options: PoolOptions): Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 30_000,
    ...(options.applicationName === undefined ? {} : { application_name: options.applicationName }),
  });
  // Without a listener, an error on an idle connection is an unhandled 'error' event and
  // Node would terminate the process. The pool discards the failed connection by itself.
  pool.on("error", (error) => {
    options.onError?.(error);
  });
  return pool;
}
