import type { Pool } from "pg";
import { APP_ROLE } from "./postgres.js";

/**
 * Checks the shape of the schema against the tenancy rules in ADR 0006, so a new table cannot be
 * added without isolation and still pass the tests. Returns one sentence per violation; an empty
 * list means the schema follows the rules.
 *
 * Run it with a privileged connection. It reads catalogs only.
 */

/** Tables that hold no tenant data and that the application role must not touch at all. */
const INTERNAL_TABLES: ReadonlySet<string> = new Set(["schema_migrations"]);

/** The tenant root. It is keyed by `id`, which is the organisation, so it has no organisation_id. */
const TENANT_ROOT_TABLES: ReadonlySet<string> = new Set(["organisations"]);

/** Tables whose rows must never change once written. The application role may only insert. */
const APPEND_ONLY_TABLES: ReadonlySet<string> = new Set(["audit_log"]);

const TENANT_SETTING = "app.organisation_id";

interface TableRow {
  oid: number;
  name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  can_truncate: boolean;
  can_trigger: boolean;
  can_reference: boolean;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
  has_organisation_column: boolean;
  organisation_column_not_null: boolean;
}

interface PolicyRow {
  table_name: string;
  policy_name: string;
  roles: string[];
  qual: string | null;
  with_check: string | null;
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

export async function findSchemaViolations(pool: Pool): Promise<string[]> {
  const violations: string[] = [];

  const tables = await pool.query<TableRow>(
    `SELECT c.oid::int AS oid,
            c.relname AS name,
            c.relrowsecurity AS rls_enabled,
            c.relforcerowsecurity AS rls_forced,
            has_table_privilege($1, c.oid, 'TRUNCATE') AS can_truncate,
            has_table_privilege($1, c.oid, 'TRIGGER') AS can_trigger,
            has_table_privilege($1, c.oid, 'REFERENCES') AS can_reference,
            has_table_privilege($1, c.oid, 'SELECT') AS can_select,
            has_table_privilege($1, c.oid, 'INSERT') AS can_insert,
            has_table_privilege($1, c.oid, 'UPDATE') AS can_update,
            has_table_privilege($1, c.oid, 'DELETE') AS can_delete,
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
    [APP_ROLE],
  );

  const policies = await pool.query<PolicyRow>(
    `SELECT tablename AS table_name, policyname AS policy_name,
            roles::text[] AS roles, qual, with_check
       FROM pg_policies
      WHERE schemaname = 'public'`,
  );

  for (const table of tables.rows) {
    const label = `table ${table.name}`;

    if (INTERNAL_TABLES.has(table.name)) {
      if (table.can_select || table.can_insert || table.can_update || table.can_delete) {
        violations.push(`${label} is internal but ${APP_ROLE} has privileges on it`);
      }
      continue;
    }

    if (!table.rls_enabled) violations.push(`${label} does not have row-level security enabled`);
    if (!table.rls_forced) violations.push(`${label} does not force row-level security`);

    const own = policies.rows.filter((policy) => policy.table_name === table.name);
    if (own.length === 0) {
      violations.push(`${label} has no row-level security policy`);
    }
    for (const policy of own) {
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
    if (table.can_truncate) violations.push(`${APP_ROLE} can TRUNCATE ${label}`);
    if (table.can_trigger) violations.push(`${APP_ROLE} can create triggers on ${label}`);
    if (table.can_reference) violations.push(`${APP_ROLE} can reference ${label}`);

    if (APPEND_ONLY_TABLES.has(table.name) && (table.can_update || table.can_delete)) {
      violations.push(`${label} is append-only but ${APP_ROLE} can update or delete it`);
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
