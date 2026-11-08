import { Pool } from "pg";

export interface PoolOptions {
  /** Connection string for the application role. Never the migration role. */
  connectionString: string;
  maxConnections?: number;
  /** Cancels any single statement that runs longer than this. Default 30 seconds. */
  statementTimeoutMs?: number;
  /** Ends sessions that sit idle inside a transaction. Default 30 seconds. */
  idleInTransactionTimeoutMs?: number;
  /** Called when an idle connection fails, for example when the database restarts. */
  onError?: (error: Error) => void;
}

export function createPool(options: PoolOptions): Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 30_000,
  });
  // Without a listener, an error on an idle connection is an unhandled 'error' event and
  // Node would terminate the process. The pool discards the failed connection by itself.
  pool.on("error", (error) => {
    options.onError?.(error);
  });
  return pool;
}
