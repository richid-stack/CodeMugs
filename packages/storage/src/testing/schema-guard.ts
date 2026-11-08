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
