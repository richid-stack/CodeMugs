import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "./pool.js";
import { withTenant, type TenantClient } from "./tenant.js";
import {
  adminDatabaseUrl,
  APP_ROLE,
  createTestDatabase,
  type TestDatabase,
} from "./testing/postgres.js";
import { findSchemaViolations } from "./testing/schema-guard.js";

const describeDatabase = adminDatabaseUrl() === undefined ? describe.skip : describe;

/** The SQLSTATE of a failed statement, or undefined for errors that are not from PostgreSQL. */
function sqlState(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return typeof error.code === "string" ? error.code : undefined;
  }
  return undefined;
}

async function failureOf(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await promise;
  } catch (error) {
    return {
      code: sqlState(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
  throw new Error("expected the statement to fail");
}

function only<T>(rows: T[]): T {
  if (rows.length !== 1) throw new Error(`expected one row but got ${rows.length}`);
  return rows[0] as T;
}

/** Organisations are created by choosing an id and setting it as the tenant in the same transaction. */
async function createOrganisation(pool: Pool, name: string): Promise<string> {
  const id = randomUUID();
  await withTenant(pool, id, (client) =>
    client.query("INSERT INTO organisations (id, name) VALUES ($1, $2)", [id, name]),
  );
  return id;
}

async function createProject(pool: Pool, organisationId: string, name: string): Promise<string> {
  return withTenant(pool, organisationId, async (client) => {
    const result = await client.query<{ id: string }>(
      "INSERT INTO projects (organisation_id, name) VALUES ($1, $2) RETURNING id",
      [organisationId, name],
    );
    return only(result.rows).id;
  });
}

/** Which tenants' rows a transaction for `organisationId` can see in `table`. */
async function visibleTenants(
  client: TenantClient,
  table: "projects" | "leaky",
): Promise<string[]> {
  const result = await client.query<{ organisation_id: string }>(
    `SELECT DISTINCT organisation_id FROM ${table} ORDER BY organisation_id`,
  );
  return result.rows.map((row) => row.organisation_id);
}

describeDatabase("tenant isolation (row-level security)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  let database: TestDatabase;
  let app: Pool;
  let admin: Pool;
  let orgA: string;
  let orgB: string;
  let projectA: string;
  let projectB: string;

  function track(pool: Pool): Pool {
    cleanup.unshift(() => pool.end());
    return pool;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    cleanup.unshift(() => database.drop());
    app = track(createPool({ connectionString: database.appUrl, maxConnections: 4 }));
    admin = track(createPool({ connectionString: database.adminUrl, maxConnections: 2 }));

    orgA = await createOrganisation(app, "Organisation A");
    orgB = await createOrganisation(app, "Organisation B");
    projectA = await createProject(app, orgA, "alpha");
    projectB = await createProject(app, orgB, "beta");
    // The same name in both organisations must be allowed.
    await createProject(app, orgA, "shared-name");
    await createProject(app, orgB, "shared-name");
  }, 60_000);

  afterAll(async () => {
    for (const close of cleanup) await close();
  });

  async function adminProjectName(id: string): Promise<string | undefined> {
    const result = await admin.query<{ name: string }>("SELECT name FROM projects WHERE id = $1", [
      id,
    ]);
    return result.rows[0]?.name;
  }

  describe("reading", () => {
    it("shows each organisation only its own projects", async () => {
      const seenByA = await withTenant(app, orgA, async (client) => {
        const result = await client.query<{ name: string; organisation_id: string }>(
          "SELECT name, organisation_id FROM projects ORDER BY name",
        );
        return result.rows;
      });
      expect(seenByA.map((row) => row.name)).toEqual(["alpha", "shared-name"]);
      expect(new Set(seenByA.map((row) => row.organisation_id))).toEqual(new Set([orgA]));

      const seenByB = await withTenant(app, orgB, (client) => visibleTenants(client, "projects"));
      expect(seenByB).toEqual([orgB]);
    });

    it("shows each organisation only itself in the organisations table", async () => {
      const rows = await withTenant(app, orgA, async (client) => {
        const result = await client.query<{ id: string }>("SELECT id FROM organisations");
        return result.rows;
      });
      expect(rows).toEqual([{ id: orgA }]);
    });

    it("cannot see another organisation's project by asking for its id", async () => {
      const rows = await withTenant(app, orgA, async (client) => {
        const result = await client.query("SELECT 1 FROM projects WHERE id = $1", [projectB]);
        return result.rows;
      });
      expect(rows).toEqual([]);
    });

    it("keeps joins and cross joins inside the tenant", async () => {
      await withTenant(app, orgA, async (client) => {
        const joined = await client.query<{ project: string; organisation: string }>(
          `SELECT p.name AS project, o.name AS organisation
             FROM projects p JOIN organisations o ON o.id = p.organisation_id`,
        );
        expect(new Set(joined.rows.map((row) => row.organisation))).toEqual(
          new Set(["Organisation A"]),
        );
        expect(joined.rows).toHaveLength(2);

        const crossed = await client.query<{ count: string }>(
          "SELECT count(*) AS count FROM projects p, organisations o",
        );
        expect(only(crossed.rows).count).toBe("2");
      });
    });

    it("shows nothing at all when no tenant has been set", async () => {
      const projects = await app.query("SELECT * FROM projects");
      const organisations = await app.query("SELECT * FROM organisations");
      expect(projects.rowCount).toBe(0);
      expect(organisations.rowCount).toBe(0);
    });
  });

  describe("writing", () => {
    it("cannot update another organisation's project", async () => {
      const affected = await withTenant(app, orgB, async (client) => {
        const result = await client.query("UPDATE projects SET name = 'hijacked' WHERE id = $1", [
          projectA,
        ]);
        return result.rowCount;
      });
      expect(affected).toBe(0);
      expect(await adminProjectName(projectA)).toBe("alpha");
    });

    it("cannot delete another organisation's project", async () => {
      const affected = await withTenant(app, orgA, async (client) => {
        const result = await client.query("DELETE FROM projects WHERE id = $1", [projectB]);
        return result.rowCount;
      });
      expect(affected).toBe(0);
      expect(await adminProjectName(projectB)).toBe("beta");
    });

    it("cannot update or delete anything when no tenant has been set", async () => {
      const updated = await app.query("UPDATE projects SET name = 'hijacked'");
      const deleted = await app.query("DELETE FROM projects");
      expect(updated.rowCount).toBe(0);
      expect(deleted.rowCount).toBe(0);
      expect(await adminProjectName(projectA)).toBe("alpha");
    });

    it("cannot insert a project for another organisation", async () => {
      const failure = await failureOf(
        withTenant(app, orgA, (client) =>
          client.query("INSERT INTO projects (organisation_id, name) VALUES ($1, 'forged')", [
            orgB,
          ]),
        ),
      );
      expect(failure.code).toBe("42501");
    });

    it("gives the same error whether or not the forged organisation exists", async () => {
      const existing = await failureOf(
        withTenant(app, orgA, (client) =>
          client.query("INSERT INTO projects (organisation_id, name) VALUES ($1, 'probe')", [orgB]),
        ),
      );
      const missing = await failureOf(
        withTenant(app, orgA, (client) =>
          client.query("INSERT INTO projects (organisation_id, name) VALUES ($1, 'probe')", [
            randomUUID(),
          ]),
        ),
      );
      // A foreign-key error for one and a policy error for the other would reveal which
      // organisations exist. The policy check must fire first for both.
      expect(existing).toEqual(missing);
      expect(existing.code).toBe("42501");
    });

    it("cannot move a project to another organisation", async () => {
      const failure = await failureOf(
        withTenant(app, orgA, (client) =>
          client.query("UPDATE projects SET organisation_id = $1 WHERE id = $2", [orgB, projectA]),
        ),
      );
      expect(failure.code).toBe("42501");
      expect(await adminProjectName(projectA)).toBe("alpha");
    });

    it("cannot create an organisation other than the one it is acting as", async () => {
      const fresh = await failureOf(
        withTenant(app, orgA, (client) =>
          client.query("INSERT INTO organisations (id, name) VALUES ($1, 'other')", [randomUUID()]),
        ),
      );
      const existing = await failureOf(
        withTenant(app, orgA, (client) =>
          client.query("INSERT INTO organisations (id, name) VALUES ($1, 'other')", [orgB]),
        ),
      );
      // Same error for an id that is free and one that is taken: no way to probe for ids.
      expect(fresh.code).toBe("42501");
      expect(existing).toEqual(fresh);
    });

    it("allows the same project name in different organisations but not twice in one", async () => {
      const failure = await failureOf(createProject(app, orgA, "shared-name"));
      expect(failure.code).toBe("23505");
    });

    it("cannot truncate a table, which would ignore row-level security", async () => {
      const failure = await failureOf(
        withTenant(app, orgA, (client) => client.query("TRUNCATE projects")),
      );
      expect(failure.code).toBe("42501");
      expect(await adminProjectName(projectB)).toBe("beta");
    });

    it("undoes everything when the work fails part way through", async () => {
      await failureOf(
        withTenant(app, orgA, async (client) => {
          await client.query(
            "INSERT INTO projects (organisation_id, name) VALUES ($1, 'temporary')",
            [orgA],
          );
          throw new Error("something went wrong after the insert");
        }),
      );
      const leftovers = await admin.query("SELECT 1 FROM projects WHERE name = 'temporary'");
      expect(leftovers.rowCount).toBe(0);
    });
  });

  describe("pooled connections", () => {
    it("does not carry a tenant over to the next user of the same connection", async () => {
      const single = track(createPool({ connectionString: database.appUrl, maxConnections: 1 }));

      const pidDuring = await withTenant(single, orgA, async (client) => {
        const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        return only(result.rows).pid;
      });
      // The pool has one connection, so this is the connection that just served organisation A.
      const afterwards = await single.query<{ pid: number; setting: string | null }>(
        "SELECT pg_backend_pid() AS pid, current_setting('app.organisation_id', true) AS setting",
      );
      expect(only(afterwards.rows).pid).toBe(pidDuring);
      expect(["", null]).toContain(only(afterwards.rows).setting);

      const projects = await single.query("SELECT * FROM projects");
      expect(projects.rowCount).toBe(0);
    });

    it("does not carry a tenant over after a failed transaction either", async () => {
      const single = track(createPool({ connectionString: database.appUrl, maxConnections: 1 }));

      await failureOf(withTenant(single, orgA, () => Promise.reject(new Error("fails"))));
      await failureOf(withTenant(single, orgA, (client) => client.query("SELECT 1 / 0")));

      const projects = await single.query("SELECT * FROM projects");
      expect(projects.rowCount).toBe(0);
    });

    it("keeps tenants apart when many concurrent requests share a small pool", async () => {
      const small = track(createPool({ connectionString: database.appUrl, maxConnections: 2 }));

      const outcomes = await Promise.all(
        Array.from({ length: 60 }, (_, index) => {
          const tenant = index % 2 === 0 ? orgA : orgB;
          return withTenant(small, tenant, async (client) => {
            // Yield to the other requests so their transactions interleave on the two connections.
            await client.query("SELECT pg_sleep($1)", [Math.random() * 0.02]);
            return { tenant, seen: await visibleTenants(client, "projects") };
          });
        }),
      );

      for (const outcome of outcomes) {
        expect(outcome.seen).toEqual([outcome.tenant]);
      }
    });
  });

  describe("the application role", () => {
    it("is not a superuser and cannot bypass row-level security", async () => {
      const result = await admin.query<Record<string, boolean>>(
        `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
           FROM pg_roles WHERE rolname = $1`,
        [APP_ROLE],
      );
      expect(only(result.rows)).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
      });
    });

    it("owns none of the tables, because owners can switch row-level security off", async () => {
      const owned = await admin.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = $1",
        [APP_ROLE],
      );
      expect(owned.rowCount).toBe(0);

      const failure = await failureOf(
        withTenant(app, orgA, (client) =>
          client.query("ALTER TABLE projects DISABLE ROW LEVEL SECURITY"),
        ),
      );
      expect(failure.code).toBe("42501");
    });

    it("cannot change the schema", async () => {
      const failure = await failureOf(app.query("CREATE TABLE sneaky (id int)"));
      expect(failure.code).toBe("42501");
    });

    it("cannot read the migration history", async () => {
      const failure = await failureOf(app.query("SELECT * FROM schema_migrations"));
      expect(failure.code).toBe("42501");
    });

    it("gets an error, not other tenants' rows, when it turns row security off", async () => {
      const failure = await failureOf(
        withTenant(app, orgA, async (client) => {
          await client.query("SET LOCAL row_security = off");
          await client.query("SELECT * FROM projects");
        }),
      );
      expect(failure.code).toBe("42501");
    });
  });

  describe("known limit", () => {
    // This is not a guarantee: it pins down what row-level security does NOT protect against, so
    // nobody mistakes it for more. The tenant is a session setting, so code that can run its own
    // SQL as the application role can set another one. Row-level security catches forgotten
    // filters and leaks between requests. It does not defend against code that chooses the wrong
    // tenant on purpose. That is why the tenant must come only from the authenticated credential
    // (invariant 1) and why withTenant is the only way application code should reach the pool.
    it("lets code that runs its own SQL switch tenant inside a transaction", async () => {
      const seen = await withTenant(app, orgA, async (client) => {
        await client.query("SELECT set_config('app.organisation_id', $1, true)", [orgB]);
        return visibleTenants(client, "projects");
      });
      expect(seen).toEqual([orgB]);
    });
  });

  describe("the schema", () => {
    it("follows the tenancy rules in every table", async () => {
      expect(await findSchemaViolations(admin)).toEqual([]);
    });
  });
});

describeDatabase("the isolation checks themselves (canary)", () => {
  // A schema with every mistake the checks exist to catch. If these checks passed here, a green
  // run on the real schema would mean nothing.
  const cleanup: Array<() => Promise<void>> = [];
  let app: Pool;
  let admin: Pool;
  const orgA = randomUUID();
  const orgB = randomUUID();

  beforeAll(async () => {
    const database = await createTestDatabase({ migrate: false });
    cleanup.unshift(() => database.drop());
    admin = createPool({ connectionString: database.adminUrl, maxConnections: 2 });
    cleanup.unshift(() => admin.end());
    app = createPool({ connectionString: database.appUrl, maxConnections: 2 });
    cleanup.unshift(() => app.end());
    await admin.query(`
      CREATE TABLE leaky (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL,
        note text NOT NULL
      );
      GRANT SELECT, INSERT, TRUNCATE ON leaky TO ${APP_ROLE};
      CREATE TABLE no_tenant_column (id int PRIMARY KEY);
      CREATE VIEW leaky_view AS SELECT * FROM leaky;
      GRANT SELECT ON leaky_view TO ${APP_ROLE};
      CREATE UNIQUE INDEX leaky_note_unique ON leaky (note);
      CREATE TABLE child (
        id int PRIMARY KEY,
        organisation_id uuid NOT NULL,
        leaky_id uuid REFERENCES leaky (id)
      );
      CREATE TABLE audit_log (id int PRIMARY KEY, organisation_id uuid NOT NULL);
      GRANT SELECT, INSERT, UPDATE ON audit_log TO ${APP_ROLE};
    `);
    await admin.query("INSERT INTO leaky (organisation_id, note) VALUES ($1, 'a'), ($2, 'b')", [
      orgA,
      orgB,
    ]);
  }, 60_000);

  afterAll(async () => {
    for (const close of cleanup) await close();
  });

  it("notices when one tenant can see another tenant's rows", async () => {
    const seen = await withTenant(app, orgA, (client) => visibleTenants(client, "leaky"));
    expect(seen).toEqual([orgA, orgB].sort());
  });

  it("reports each mistake in the schema", async () => {
    const violations = await findSchemaViolations(admin);
    expect(violations).toEqual(
      expect.arrayContaining([
        "table leaky does not have row-level security enabled",
        "table leaky does not force row-level security",
        "table leaky has no row-level security policy",
        `${APP_ROLE} can TRUNCATE table leaky`,
        "table no_tenant_column has no organisation_id column",
        "view leaky_view is not security_invoker and would bypass row-level security",
        "unique index leaky_note_unique on leaky does not include organisation_id",
        "foreign key child_leaky_id_fkey from child to leaky does not include organisation_id on both sides",
        `table audit_log is append-only but ${APP_ROLE} can update or delete it`,
      ]),
    );
  });
});

describe("the harness", () => {
  it("fails instead of skipping when database tests are required but no database is configured", () => {
    const saved = {
      url: process.env["CODEMUGS_TEST_DATABASE_URL"],
      require: process.env["REQUIRE_DATABASE_TESTS"],
    };
    try {
      delete process.env["CODEMUGS_TEST_DATABASE_URL"];
      process.env["REQUIRE_DATABASE_TESTS"] = "true";
      expect(() => adminDatabaseUrl()).toThrow(/REQUIRE_DATABASE_TESTS/);

      delete process.env["REQUIRE_DATABASE_TESTS"];
      expect(adminDatabaseUrl()).toBeUndefined();
    } finally {
      if (saved.url === undefined) delete process.env["CODEMUGS_TEST_DATABASE_URL"];
      else process.env["CODEMUGS_TEST_DATABASE_URL"] = saved.url;
      if (saved.require === undefined) delete process.env["REQUIRE_DATABASE_TESTS"];
      else process.env["REQUIRE_DATABASE_TESTS"] = saved.require;
    }
  });
});
