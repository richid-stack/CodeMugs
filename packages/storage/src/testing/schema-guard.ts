import type { Pool } from "pg";
import { APP_ROLE, DISPATCHER_ROLE } from "./postgres.js";

/**
 * Checks the shape of the schema against the tenancy rules in ADR 0006 and the dispatcher rules in
 * ADR 0012, so a new table cannot be added without isolation and still pass the tests. Returns one
 * sentence per violation; an empty list means the schema follows the rules.
 *
 * Run it with a privileged connection. It reads catalogs only.
 */

/** Tables that hold no tenant data and that neither runtime role may touch at all. */
const INTERNAL_TABLES: ReadonlySet<string> = new Set(["schema_migrations"]);

/** The tenant root. It is keyed by `id`, which is the organisation, so it has no organisation_id. */
const TENANT_ROOT_TABLES: ReadonlySet<string> = new Set(["organisations"]);

/** Tables whose rows must never change once written. The application role may only insert. */
const APPEND_ONLY_TABLES: ReadonlySet<string> = new Set(["audit_log", "events"]);

/**
 * Tables whose rows may change but are never deleted by a runtime role. Deleting them for
 * retention needs a deliberate, audited path that does not exist yet (release gate 15).
 */
const KEPT_TABLES: ReadonlySet<string> = new Set(["jobs", "event_aggregates"]);

/**
 * The only tables the dispatcher role may read and update, across tenants. It exists so workers
 * can find the next job in any tenant, and it must never reach tenant data (ADR 0012).
 */
const DISPATCHER_TABLES: ReadonlySet<string> = new Set(["jobs"]);

/**
 * Every column of a dispatcher table. The dispatcher reads these rows across tenants, so a new
 * column (above all one that could hold customer data, like a payload) is a decision to record in
 * ADR 0012 and then add here, never a side effect of a migration.
 */
const DISPATCHER_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  jobs: [
    "id",
    "organisation_id",
    "kind",
    "subject_id",
    "status",
    "available_at",
    "attempts",
    "max_attempts",
    "lease_token",
    "last_error_code",
    "created_at",
    "finished_at",
  ],
};

/**
 * For tables whose rows change after insert: the columns that may change. Every other column
 * (whose row it is, what a job is, which hour a count is for) is fixed for life, for every role.
 */
const UPDATABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  jobs: ["status", "available_at", "attempts", "lease_token", "last_error_code", "finished_at"],
  event_aggregates: ["event_count", "updated_at"],
};

const TENANT_SETTING = "app.organisation_id";

const RUNTIME_ROLES: readonly string[] = [APP_ROLE, DISPATCHER_ROLE];

interface TableRow {
  name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  has_organisation_column: boolean;
  organisation_column_not_null: boolean;
}

interface Privileges {
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
  can_truncate: boolean;
  can_trigger: boolean;
  can_reference: boolean;
}

interface PolicyRow {
  table_name: string;
  policy_name: string;
  roles: string[];
  qual: string | null;
  with_check: string | null;
}

interface RoleRow {
  name: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
}

interface ViewRow {
  name: string;
  kind: string;
  security_invoker: boolean;
}

interface ForeignKeyRow {
  name: string;
  source: string;
  target: string;
  source_columns: string[];
  target_columns: string[];
}

interface UniqueIndexRow {
  table_name: string;
  index_name: string;
  columns: string[];
}

/**
 * What a role may do to each table. A privilege on only some columns counts: it is still a way to
 * read or change rows, and `has_table_privilege` would miss it.
 */
async function tablePrivileges(pool: Pool, role: string): Promise<Map<string, Privileges>> {
  const result = await pool.query<Privileges & { name: string }>(
    `SELECT c.relname AS name,
            has_any_column_privilege($1, c.oid, 'SELECT') AS can_select,
            has_any_column_privilege($1, c.oid, 'INSERT') AS can_insert,
            has_any_column_privilege($1, c.oid, 'UPDATE') AS can_update,
            has_table_privilege($1, c.oid, 'DELETE') AS can_delete,
            has_table_privilege($1, c.oid, 'TRUNCATE') AS can_truncate,
            has_table_privilege($1, c.oid, 'TRIGGER') AS can_trigger,
            has_any_column_privilege($1, c.oid, 'REFERENCES') AS can_reference
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
    [role],
  );
  return new Map(result.rows.map(({ name, ...privileges }) => [name, privileges]));
}

function privilegesOn(all: Map<string, Privileges>, table: string): Privileges {
  const found = all.get(table);
  if (found === undefined) throw new Error(`no privileges were read for table ${table}`);
  return found;
}

export async function findSchemaViolations(pool: Pool): Promise<string[]> {
  const violations: string[] = [];

  // The roles come first: every privilege check below needs them to exist, and a runtime role
  // that is more powerful than it looks makes the rest of the schema's rules meaningless.
  const roles = await pool.query<RoleRow>(
    `SELECT rolname AS name, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
       FROM pg_roles
      WHERE rolname = ANY ($1)
      ORDER BY rolname`,
    [RUNTIME_ROLES],
  );
  for (const role of RUNTIME_ROLES) {
    if (!roles.rows.some((row) => row.name === role)) {
      violations.push(`role ${role} does not exist`);
    }
  }
  if (violations.length > 0) return violations;
  for (const role of roles.rows) {
    const powers = [
      role.rolsuper && "superuser",
      role.rolbypassrls && "bypass row-level security",
      role.rolcreaterole && "create roles",
      role.rolcreatedb && "create databases",
      role.rolreplication && "replicate",
    ].filter((power): power is string => power !== false);
    if (powers.length > 0) violations.push(`role ${role.name} can ${powers.join(", ")}`);
  }

  // A role that owns a table can switch row-level security off for it. A role that belongs to
  // another role has that role's rights as well as its own.
  const owned = await pool.query<{ name: string; owner: string }>(
    `SELECT c.relname AS name, r.rolname AS owner
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND r.rolname = ANY ($1)
      ORDER BY c.relname`,
    [RUNTIME_ROLES],
  );
  for (const row of owned.rows) {
    violations.push(`role ${row.owner} owns ${row.name}, and an owner can switch row security off`);
  }
  const memberships = await pool.query<{ member: string; granted: string }>(
    `SELECT m.rolname AS member, g.rolname AS granted
       FROM pg_auth_members am
       JOIN pg_roles m ON m.oid = am.member
       JOIN pg_roles g ON g.oid = am.roleid
      WHERE m.rolname = ANY ($1) OR g.rolname = ANY ($1)
      ORDER BY m.rolname, g.rolname`,
    [RUNTIME_ROLES],
  );
  for (const row of memberships.rows) {
    violations.push(`role ${row.member} is a member of role ${row.granted}`);
  }

  const tables = await pool.query<TableRow>(
    `SELECT c.relname AS name,
            c.relrowsecurity AS rls_enabled,
            c.relforcerowsecurity AS rls_forced,
            EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'organisation_id'
                      AND a.attnum > 0 AND NOT a.attisdropped) AS has_organisation_column,
            EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'organisation_id'
                      AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull)
              AS organisation_column_not_null
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`,
  );
  const appPrivileges = await tablePrivileges(pool, APP_ROLE);
  const dispatcherPrivileges = await tablePrivileges(pool, DISPATCHER_ROLE);

  const policies = await pool.query<PolicyRow>(
    `SELECT tablename AS table_name, policyname AS policy_name,
            roles::text[] AS roles, qual, with_check
       FROM pg_policies
      WHERE schemaname = 'public'`,
  );

  for (const table of tables.rows) {
    const label = `table ${table.name}`;
    const app = privilegesOn(appPrivileges, table.name);
    const dispatcher = privilegesOn(dispatcherPrivileges, table.name);

    if (INTERNAL_TABLES.has(table.name)) {
      for (const [role, held] of [
        [APP_ROLE, app],
        [DISPATCHER_ROLE, dispatcher],
      ] as const) {
        if (held.can_select || held.can_insert || held.can_update || held.can_delete) {
          violations.push(`${label} is internal but ${role} has privileges on it`);
        }
      }
      continue;
    }

    if (!table.rls_enabled) violations.push(`${label} does not have row-level security enabled`);
    if (!table.rls_forced) violations.push(`${label} does not force row-level security`);

    const own = policies.rows.filter((policy) => policy.table_name === table.name);
    // A policy that names the dispatcher is the one deliberate exception to tenant scoping. It
    // may exist only on the dispatcher's tables, and only for the dispatcher alone: sharing it
    // with another role would hand that role every tenant's rows.
    const tenantPolicies = own.filter((policy) => !policy.roles.includes(DISPATCHER_ROLE));
    if (own.length === 0) {
      violations.push(`${label} has no row-level security policy`);
    } else if (tenantPolicies.length === 0) {
      violations.push(`${label} has no tenant policy, only one for ${DISPATCHER_ROLE}`);
    }
    for (const policy of own) {
      if (policy.roles.includes(DISPATCHER_ROLE)) {
        if (!DISPATCHER_TABLES.has(table.name)) {
          violations.push(
            `policy ${policy.policy_name} on ${table.name} lets ${DISPATCHER_ROLE} see rows across tenants`,
          );
        }
        if (policy.roles.some((role) => role !== DISPATCHER_ROLE)) {
          violations.push(
            `policy ${policy.policy_name} on ${table.name} shares ${DISPATCHER_ROLE}'s cross-tenant access with another role`,
          );
        }
        continue;
      }
      const expression = `${policy.qual ?? ""} ${policy.with_check ?? ""}`;
      if (!expression.includes(TENANT_SETTING)) {
        violations.push(
          `policy ${policy.policy_name} on ${table.name} does not depend on ${TENANT_SETTING}`,
        );
      }
      if (policy.roles.includes("public")) {
        violations.push(`policy ${policy.policy_name} on ${table.name} applies to every role`);
      }
    }

    if (!TENANT_ROOT_TABLES.has(table.name)) {
      if (!table.has_organisation_column) {
        violations.push(`${label} has no organisation_id column`);
      } else if (!table.organisation_column_not_null) {
        violations.push(`${label} allows a null organisation_id`);
      }
    }

    // TRUNCATE ignores row-level security. TRIGGER and REFERENCES let a role attach code to, or
    // probe, rows it cannot see.
    for (const [role, held] of [
      [APP_ROLE, app],
      [DISPATCHER_ROLE, dispatcher],
    ] as const) {
      if (held.can_truncate) violations.push(`${role} can TRUNCATE ${label}`);
      if (held.can_trigger) violations.push(`${role} can create triggers on ${label}`);
      if (held.can_reference) violations.push(`${role} can reference ${label}`);
    }

    if (APPEND_ONLY_TABLES.has(table.name) && (app.can_update || app.can_delete)) {
      violations.push(`${label} is append-only but ${APP_ROLE} can update or delete it`);
    }
    if (KEPT_TABLES.has(table.name) && app.can_delete) {
      violations.push(`${label} keeps its rows but ${APP_ROLE} can delete them`);
    }

    // The dispatcher sees across tenants, so it gets the least it can work with: the jobs table,
    // read and update, never insert or delete, and no other table at all.
    if (DISPATCHER_TABLES.has(table.name)) {
      if (dispatcher.can_insert) violations.push(`${DISPATCHER_ROLE} can insert into ${label}`);
      if (dispatcher.can_delete) violations.push(`${DISPATCHER_ROLE} can delete from ${label}`);
    } else if (
      dispatcher.can_select ||
      dispatcher.can_insert ||
      dispatcher.can_update ||
      dispatcher.can_delete
    ) {
      violations.push(`${DISPATCHER_ROLE} has privileges on ${label}, which is not a job table`);
    }
  }

  // Row-level security decides which rows a role sees, not which columns it may change. Fixed
  // columns (the owner of a row, what a job is) are protected by privileges instead.
  for (const [table, allowed] of Object.entries(UPDATABLE_COLUMNS)) {
    const columns = await pool.query<{ column_name: string; app: boolean; dispatcher: boolean }>(
      `SELECT a.attname AS column_name,
              has_column_privilege($2, c.oid, a.attnum, 'UPDATE') AS app,
              has_column_privilege($3, c.oid, a.attnum, 'UPDATE') AS dispatcher
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND c.relname = $1
        ORDER BY a.attnum`,
      [table, APP_ROLE, DISPATCHER_ROLE],
    );
    for (const column of columns.rows) {
      if (allowed.includes(column.column_name)) continue;
      if (column.app) {
        violations.push(
          `${APP_ROLE} can update column ${column.column_name} of table ${table}, which must stay fixed`,
        );
      }
      if (column.dispatcher) {
        violations.push(
          `${DISPATCHER_ROLE} can update column ${column.column_name} of table ${table}, which must stay fixed`,
        );
      }
    }
  }

  for (const [table, expected] of Object.entries(DISPATCHER_TABLE_COLUMNS)) {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND c.relname = $1
        ORDER BY a.attnum`,
      [table],
    );
    for (const column of columns.rows) {
      if (!expected.includes(column.column_name)) {
        violations.push(
          `table ${table} has column ${column.column_name}, which ${DISPATCHER_ROLE} would read across tenants; decide it in ADR 0012 first`,
        );
      }
    }
  }

  const tenantTables = new Set(
    tables.rows.map((table) => table.name).filter((name) => !INTERNAL_TABLES.has(name)),
  );

  // A foreign key between two tenant tables must carry organisation_id on both sides, so a row
  // can never point at another tenant's row. References to the tenant root are exempt.
  const foreignKeys = await pool.query<ForeignKeyRow>(
    `SELECT c.conname AS name,
            src.relname AS source,
            dst.relname AS target,
            ARRAY(SELECT a.attname::text FROM pg_attribute a
                   WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) AS source_columns,
            ARRAY(SELECT a.attname::text FROM pg_attribute a
                   WHERE a.attrelid = c.confrelid AND a.attnum = ANY (c.confkey)) AS target_columns
       FROM pg_constraint c
       JOIN pg_class src ON src.oid = c.conrelid
       JOIN pg_class dst ON dst.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = src.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'
      ORDER BY c.conname`,
  );
  for (const key of foreignKeys.rows) {
    if (!tenantTables.has(key.source) || !tenantTables.has(key.target)) continue;
    if (TENANT_ROOT_TABLES.has(key.target)) continue;
    if (
      !key.source_columns.includes("organisation_id") ||
      !key.target_columns.includes("organisation_id")
    ) {
      violations.push(
        `foreign key ${key.name} from ${key.source} to ${key.target} does not include organisation_id on both sides`,
      );
    }
  }

  // A unique constraint that ignores organisation_id would let one tenant discover that another
  // tenant holds a value, because the clash is reported across tenants. Primary keys are random
  // identifiers and are exempt.
  const uniqueIndexes = await pool.query<UniqueIndexRow>(
    `SELECT t.relname AS table_name,
            i.relname AS index_name,
            ARRAY(SELECT a.attname::text FROM pg_attribute a
                   WHERE a.attrelid = ix.indrelid AND a.attnum = ANY (ix.indkey::int2[])) AS columns
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND ix.indisunique AND NOT ix.indisprimary
      ORDER BY i.relname`,
  );
  for (const index of uniqueIndexes.rows) {
    if (!tenantTables.has(index.table_name) || TENANT_ROOT_TABLES.has(index.table_name)) continue;
    if (!index.columns.includes("organisation_id")) {
      violations.push(
        `unique index ${index.index_name} on ${index.table_name} does not include organisation_id`,
      );
    }
  }

  // Views run with their owner's rights unless they are security invoker, which would show every
  // tenant's rows. Materialised views cannot have row-level security at all.
  const views = await pool.query<ViewRow>(
    `SELECT c.relname AS name,
            c.relkind AS kind,
            COALESCE('security_invoker=true' = ANY (c.reloptions), false) AS security_invoker
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
      ORDER BY c.relname`,
  );
  for (const view of views.rows) {
    if (view.kind === "m") {
      violations.push(`materialised view ${view.name} cannot enforce row-level security`);
    } else if (!view.security_invoker) {
      violations.push(
        `view ${view.name} is not security_invoker and would bypass row-level security`,
      );
    }
  }

  return violations;
}
