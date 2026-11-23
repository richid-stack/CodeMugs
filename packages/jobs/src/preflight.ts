import { describeFailure } from "@codemugs/logging";
import { APP_ROLE, DISPATCHER_ROLE, postgresErrorCode, type Pool } from "@codemugs/storage";

/** Why a worker cannot start, as far as its database is concerned. */
export type DatabaseStartupCode =
  "database_unreachable" | "wrong_role" | "role_too_powerful" | "schema_not_ready";

/**
 * A worker cannot safely start. The message names the variable and says what is wrong, and never
 * includes a connection string, a role's password or anything the database returned.
 *
 * The code is one of {@link DatabaseStartupCode} for what this library checks. A process that checks
 * more (the process that analyses a repository checks its sandbox) adds codes of its own.
 */
export class WorkerStartupError<Code extends string = DatabaseStartupCode> extends Error {
  readonly code: Code;
  readonly variable: string;

  constructor(code: Code, variable: string, message: string) {
    super(`${variable}: ${message}`);
    this.name = "WorkerStartupError";
    this.code = code;
    this.variable = variable;
  }
}

/**
 * What each connection of a worker has to be able to use: queries that touch it and read nothing.
 * Without a tenant set, row-level security returns no rows from the tenant tables, so these read
 * nothing. They fail if the table or column is missing (a database that is not migrated far
 * enough) or if the role may not use it.
 */
export interface DatabaseProbes {
  /** The application role: what the handlers read and write. */
  readonly app: readonly string[];
  /** The dispatcher role: what finds due jobs, and nothing else. */
  readonly dispatcher: readonly string[];
}

// undefined_table, undefined_column, insufficient_privilege.
const SCHEMA_NOT_READY = new Set(["42P01", "42703", "42501"]);

interface Connection {
  variable: string;
  pool: Pool;
  role: string;
  probes: readonly string[];
}

interface RoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  /** How many roles this one is a member of. A count comes back from the driver as a string. */
  memberships: string;
}

async function verify(connection: Connection): Promise<void> {
  const { variable, pool, role, probes } = connection;

  let row: RoleRow | undefined;
  try {
    const result = await pool.query<RoleRow>(
      `SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
              r.rolreplication,
              (SELECT count(*) FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
                AS memberships
         FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
    );
    row = result.rows[0];
  } catch (error) {
    throw new WorkerStartupError(
      "database_unreachable",
      variable,
      `could not connect and query (${describeFailure(error)})`,
    );
  }
  if (row?.rolname !== role) {
    throw new WorkerStartupError("wrong_role", variable, `must connect as the role ${role}`);
  }
  // The role contract (infrastructure/database): none of these. A role with any of them could
  // read across tenants, which row-level security exists to prevent (ADR 0006).
  if (
    row.rolsuper ||
    row.rolbypassrls ||
    row.rolcreaterole ||
    row.rolcreatedb ||
    row.rolreplication
  ) {
    throw new WorkerStartupError(
      "role_too_powerful",
      variable,
      `the role ${role} has more privileges than the role contract allows`,
    );
  }
  // A member of another role can take that role's powers with SET ROLE, or inherit its grants,
  // which for the dispatcher would be more than the jobs table. The runtime roles belong to none.
  if (Number(row.memberships) > 0) {
    throw new WorkerStartupError(
      "role_too_powerful",
      variable,
      `the role ${role} is a member of other roles, which the role contract does not allow`,
    );
  }

  for (const probe of probes) {
    try {
      await pool.query(probe);
    } catch (error) {
      const sqlstate = postgresErrorCode(error);
      if (sqlstate !== undefined && SCHEMA_NOT_READY.has(sqlstate)) {
        throw new WorkerStartupError(
          "schema_not_ready",
          variable,
          `the database is missing what the worker needs, or ${role} may not use it (db_${sqlstate}); run the migrations`,
        );
      }
      throw new WorkerStartupError(
        "database_unreachable",
        variable,
        `could not query (${describeFailure(error)})`,
      );
    }
  }
}

/**
 * Checks, before any job is taken, that each connection is the role it should be, that the role
 * has no more power than the role contract allows, and that the schema has what the handlers use.
 *
 * Each of these fails silently or dangerously otherwise. The application role used as the
 * dispatcher sees no jobs, so the worker would idle forever. A superuser used for either
 * connection bypasses tenant isolation. A database that is not migrated far enough would fail
 * every job until it was given up on.
 *
 * `probes` is what the process's own handlers use, so that each worker finds out at the start and
 * not on its first job. `roles` is for tests, which use throwaway roles.
 */
export async function verifyWorkerDatabase(
  pools: { app: Pool; dispatcher: Pool },
  probes: DatabaseProbes,
  roles: { app: string; dispatcher: string } = { app: APP_ROLE, dispatcher: DISPATCHER_ROLE },
): Promise<void> {
  await verify({
    variable: "DATABASE_URL",
    pool: pools.app,
    role: roles.app,
    probes: probes.app,
  });
  await verify({
    variable: "DISPATCHER_DATABASE_URL",
    pool: pools.dispatcher,
    role: roles.dispatcher,
    probes: probes.dispatcher,
  });
}
