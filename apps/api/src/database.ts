import { authenticateApiKey } from "@codemugs/auth";
import type { Secret } from "@codemugs/configuration";
import { recordEvents } from "@codemugs/ingestion";
import { createPool } from "@codemugs/storage";
import type { Authenticator } from "./authentication.js";
import type { EventIngester } from "./ingestion.js";
import type { ReadinessCheck } from "./routes/health.js";

export interface DatabaseServices {
  authenticate: Authenticator;
  ingest: EventIngester;
  readiness: ReadinessCheck;
  close(): Promise<void>;
}

/**
 * Connects the API to the database as the restricted application role. Migrations are not run
 * here: they need a privileged role and run as a separate step (ADR 0009).
 */
export function createDatabaseServices(
  databaseUrl: Secret,
  options: { onError: (error: Error) => void },
): DatabaseServices {
  const pool = createPool({ connectionString: databaseUrl.reveal(), onError: options.onError });
  return {
    authenticate: (presentedKey) => authenticateApiKey(pool, presentedKey),
    ingest: (scope, body) => recordEvents(pool, scope, body),
    readiness: {
      name: "database",
      timeoutMs: 1_500,
      check: async () => {
        // No tenant is set, so row-level security returns no rows and nothing is read. This only
        // proves that the connection works, that the schema has been migrated this far, and that
        // the application role may use the table.
        await pool.query("SELECT 1 FROM api_keys LIMIT 1");
      },
    },
    close: () => pool.end(),
  };
}
