import type { MigrationConfig } from "@codemugs/configuration";
import { describeFailure, type Logger } from "@codemugs/logging";
import {
  APP_ROLE,
  createPool,
  DISPATCHER_ROLE,
  loadMigrations,
  MigrationError,
  runMigrations,
} from "@codemugs/storage";

/** What `pg_stat_activity` shows for the session that runs the migrations. */
export const APPLICATION_NAME = "codemugs-migrate";

export type MigrationFailureCode =
  | "migrations_invalid"
  | "database_unreachable"
  | "wrong_role"
  | "roles_missing"
  | "history_mismatch"
  | "migration_failed"
  | "database_error";

export type MigrateResult =
  | {
      ok: true;
      /** The versions this run applied, in order. Empty when the database was up to date. */
      applied: string[];
      /** How many migrations this build contains. */
      total: number;
    }
  | {
      ok: false;
      code: MigrationFailureCode;
      /** Safe to print: it names a variable, a version or a role, and nothing the database said. */
      message: string;
      /** The migration the failure is about, when it is about one. */
      version?: string;
    };

export interface MigrateOptions {
  config: MigrationConfig;
  logger: Logger;
  /** For tests. Defaults to the migrations shipped with `@codemugs/storage`. */
  directory?: URL | string;
  /** For tests, which use throwaway roles. */
  roles?: { app: string; dispatcher: string };
}

interface Checked {
  role: string;
  present: string[];
}

/**
 * Applies the migrations that are pending, as the migration role, and reports what it did. It
 * returns a failure instead of throwing for everything it expects to go wrong; the caller turns
 * that into an exit code.
 *
 * Before it changes anything it checks that the connection is not a runtime role (ADR 0009: the
 * application never connects as the migration role, and the reverse is as important) and that the
 * roles the migrations refer to exist. The failure messages never include the connection string,
 * the SQL, or anything the database said: a failed migration is reported by its version and the
 * SQLSTATE of its error, because a data error can repeat the value it rejected.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const { config, logger } = options;
  const roles = options.roles ?? { app: APP_ROLE, dispatcher: DISPATCHER_ROLE };
  const fail = (
    code: MigrationFailureCode,
    message: string,
    fields: { version?: string; cause?: string } = {},
  ): MigrateResult => {
    logger.error(message, { code, ...fields });
    return {
      ok: false,
      code,
      message,
      ...(fields.version === undefined ? {} : { version: fields.version }),
    };
  };

  let total: number;
  try {
    total = (await loadMigrations(options.directory)).length;
  } catch (error) {
    if (error instanceof MigrationError) return fail("migrations_invalid", error.message);
    throw error;
  }

  // One connection, for the checks only. The migrations run on their own session, because the
  // lock that serialises runners belongs to a session (ADR 0009).
  const pool = createPool({
    connectionString: config.databaseUrl.reveal(),
    maxConnections: 1,
    connectionTimeoutMs: 15_000,
    onError: () => undefined,
  });
  let checked: Checked;
  try {
    const result = await pool.query<{ role: string; present: string[] }>(
      `SELECT current_user::text AS role,
              ARRAY(SELECT rolname::text FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[]))
                AS present`,
      [[roles.app, roles.dispatcher]],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("no row");
    checked = row;
  } catch (error) {
    return fail(
      "database_unreachable",
      `MIGRATION_DATABASE_URL: could not connect and query (${describeFailure(error)})`,
    );
  } finally {
    await pool.end();
  }

  if (checked.role === roles.app || checked.role === roles.dispatcher) {
    return fail(
      "wrong_role",
      `MIGRATION_DATABASE_URL: must connect as the migration role, not as the runtime role ${checked.role}`,
    );
  }
  const missing = [roles.app, roles.dispatcher].filter((role) => !checked.present.includes(role));
  if (missing.length > 0) {
    return fail(
      "roles_missing",
      `the roles ${missing.join(", ")} do not exist; infrastructure creates them before the migrations run (infrastructure/database/README.md)`,
    );
  }

  try {
    const applied = await runMigrations(config.databaseUrl.reveal(), options.directory, {
      applicationName: APPLICATION_NAME,
      onApplied: ({ version, name }) => {
        logger.info("migration applied", { version, name });
      },
    });
    logger.info(applied.length === 0 ? "database is up to date" : "migrations applied", {
      applied: applied.length,
      total,
    });
    return { ok: true, applied, total };
  } catch (error) {
    if (error instanceof MigrationError) {
      const version = error.version;
      const fields = version === undefined ? {} : { version };
      // A failure with a cause is a migration that did not run. One without is the history not
      // matching the files: a file changed, out of order, or the database is ahead of this build.
      return error.cause === undefined
        ? fail("history_mismatch", error.message, fields)
        : fail("migration_failed", error.message, {
            ...fields,
            cause: describeFailure(error.cause),
          });
    }
    return fail("database_error", `the migrations could not run (${describeFailure(error)})`);
  }
}
