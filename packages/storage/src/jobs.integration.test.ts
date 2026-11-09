import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "./pool.js";
import { withTenant } from "./tenant.js";
import { adminDatabaseUrl, createTestDatabase, type TestDatabase } from "./testing/postgres.js";
import { findSchemaViolations } from "./testing/schema-guard.js";

const describeDatabase = adminDatabaseUrl() === undefined ? describe.skip : describe;

/** The SQLSTATE of a failed statement. Fails the test if the statement succeeds. */
async function sqlStateOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      return typeof error.code === "string" ? error.code : undefined;
    }
    return undefined;
  }
  throw new Error("expected the statement to fail");
}

function only<T>(rows: T[]): T {
  if (rows.length !== 1) throw new Error(`expected one row but got ${rows.length}`);
  return rows[0] as T;
}

interface JobSpec {
  organisationId: string;
  kind?: string;
  subjectId?: string | null;
  status?: string;
  attempts?: number;
  maxAttempts?: number;
  leaseToken?: string | null;
  finished?: boolean;
}

describeDatabase("the jobs table", () => {
  const cleanup: Array<() => Promise<void>> = [];
  let database: TestDatabase;
  let app: Pool;
  let dispatcher: Pool;
  let admin: Pool;
  const orgA = randomUUID();
  const orgB = randomUUID();

  /** Inserts a job as the superuser, so a test can set up any state, even ones the code avoids. */
  async function seed(spec: JobSpec): Promise<string> {
    const result = await admin.query<{ id: string }>(
      `INSERT INTO jobs (organisation_id, kind, subject_id, status, attempts, max_attempts,
                         lease_token, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::boolean THEN now() END)
       RETURNING id`,
      [
        spec.organisationId,
        spec.kind ?? "test.job",
        spec.subjectId === undefined ? randomUUID() : spec.subjectId,
        spec.status ?? "queued",
        spec.attempts ?? 0,
        spec.maxAttempts ?? 5,
        spec.leaseToken ?? null,
        spec.finished ?? false,
      ],
    );
    return only(result.rows).id;
  }

  /** Inserts a job as the application role, within the given tenant. */
  function enqueueAs(
    tenant: string,
    spec: Partial<JobSpec> = {},
    organisationId: string = spec.organisationId ?? tenant,
  ): Promise<unknown> {
    return withTenant(app, tenant, (client) =>
      client.query(
        `INSERT INTO jobs (organisation_id, kind, subject_id, status, attempts, max_attempts,
                           lease_token, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::boolean THEN now() END)`,
        [
          organisationId,
          spec.kind ?? "test.job",
          spec.subjectId === undefined ? randomUUID() : spec.subjectId,
          spec.status ?? "queued",
          spec.attempts ?? 0,
          spec.maxAttempts ?? 5,
          spec.leaseToken ?? null,
          spec.finished ?? false,
        ],
      ),
    );
  }

  const asApp = (tenant: string, sql: string, values: unknown[] = []): Promise<unknown> =>
    withTenant(app, tenant, (client) => client.query(sql, values));

  beforeAll(async () => {
    database = await createTestDatabase();
    cleanup.unshift(() => database.drop());
    app = createPool({ connectionString: database.appUrl, maxConnections: 4 });
    cleanup.unshift(() => app.end());
    dispatcher = createPool({ connectionString: database.dispatcherUrl, maxConnections: 4 });
    cleanup.unshift(() => dispatcher.end());
    admin = createPool({ connectionString: database.adminUrl, maxConnections: 2 });
    cleanup.unshift(() => admin.end());
    for (const [id, name] of [
      [orgA, "A"],
      [orgB, "B"],
    ] as const) {
      await withTenant(app, id, (client) =>
        client.query("INSERT INTO organisations (id, name) VALUES ($1, $2)", [id, name]),
      );
    }
  }, 60_000);

  afterAll(async () => {
    for (const close of cleanup) await close();
  });

  it("passes the schema guard, including the dispatcher rules", async () => {
    expect(await findSchemaViolations(admin)).toEqual([]);
  });

  describe("tenant isolation for the application role", () => {
    it("shows each tenant only its own jobs, and nothing when no tenant is set", async () => {
      await seed({ organisationId: orgA });
      await seed({ organisationId: orgA });
      await seed({ organisationId: orgB });
      const count = (tenant: string): Promise<number> =>
        withTenant(app, tenant, async (client) =>
          Number(
            only((await client.query<{ n: string }>("SELECT count(*) AS n FROM jobs")).rows).n,
          ),
        );
      expect(await count(orgA)).toBe(2);
      expect(await count(orgB)).toBe(1);
      expect(await count(randomUUID())).toBe(0);
      const outside = await app.query<{ n: string }>("SELECT count(*) AS n FROM jobs");
      expect(Number(only(outside.rows).n)).toBe(0);
    });

    it("refuses a job that names another organisation than the tenant", async () => {
      expect(await sqlStateOf(enqueueAs(orgB, {}, orgA))).toBe("42501");
      expect(await sqlStateOf(enqueueAs(orgA, {}, orgB))).toBe("42501");
    });

    it("cannot update another tenant's job", async () => {
      const id = await seed({ organisationId: orgB });
      await withTenant(app, orgA, async (client) => {
        const result = await client.query("UPDATE jobs SET status = 'dead' WHERE id = $1", [id]);
        expect(result.rowCount).toBe(0);
      });
      const row = await admin.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [
        id,
      ]);
      expect(only(row.rows).status).toBe("queued");
    });
  });

  describe("what a job may be", () => {
    it("keeps the kind to a short lower-case name", async () => {
      for (const kind of ["", "Upper", "1starts-with-digit", "has space", "a".repeat(65)]) {
        expect(await sqlStateOf(enqueueAs(orgA, { kind }))).toBe("23514");
      }
      await expect(enqueueAs(orgA, { kind: "events.aggregate" })).resolves.toBeDefined();
      await expect(enqueueAs(orgA, { kind: "a".repeat(64) })).resolves.toBeDefined();
    });

    it("only allows the four known states", async () => {
      expect(await sqlStateOf(enqueueAs(orgA, { status: "paused" }))).toBe("23514");
    });

    it("never lets attempts pass the maximum", async () => {
      expect(await sqlStateOf(enqueueAs(orgA, { attempts: 6, maxAttempts: 5 }))).toBe("23514");
      expect(await sqlStateOf(enqueueAs(orgA, { maxAttempts: 0 }))).toBe("23514");
      expect(await sqlStateOf(enqueueAs(orgA, { maxAttempts: 101 }))).toBe("23514");
      expect(await sqlStateOf(enqueueAs(orgA, { attempts: -1 }))).toBe("23514");
    });

    it("holds a lease token exactly while the job is running", async () => {
      expect(await sqlStateOf(enqueueAs(orgA, { status: "running" }))).toBe("23514");
      expect(await sqlStateOf(enqueueAs(orgA, { leaseToken: randomUUID() }))).toBe("23514");
      await expect(
        enqueueAs(orgA, { status: "running", attempts: 1, leaseToken: randomUUID() }),
      ).resolves.toBeDefined();
    });

    it("has a finish time exactly when the job is over", async () => {
      expect(await sqlStateOf(enqueueAs(orgA, { status: "succeeded" }))).toBe("23514");
      expect(await sqlStateOf(enqueueAs(orgA, { status: "dead" }))).toBe("23514");
      expect(await sqlStateOf(enqueueAs(orgA, { finished: true }))).toBe("23514");
      await expect(enqueueAs(orgA, { status: "dead", finished: true })).resolves.toBeDefined();
    });
  });

  describe("one job per subject", () => {
    it("rejects a second job of the same kind for the same subject", async () => {
      const subjectId = randomUUID();
      await enqueueAs(orgA, { kind: "dedupe.me", subjectId });
      expect(await sqlStateOf(enqueueAs(orgA, { kind: "dedupe.me", subjectId }))).toBe("23505");
    });

    it("lets ON CONFLICT DO NOTHING report the duplicate by returning no row", async () => {
      const subjectId = randomUUID();
      const insert = (): Promise<number> =>
        withTenant(app, orgA, async (client) => {
          const result = await client.query(
            `INSERT INTO jobs (organisation_id, kind, subject_id) VALUES ($1, 'dedupe.again', $2)
             ON CONFLICT (organisation_id, kind, subject_id) DO NOTHING RETURNING id`,
            [orgA, subjectId],
          );
          return result.rowCount ?? -1;
        });
      expect(await insert()).toBe(1);
      expect(await insert()).toBe(0);
    });

    it("scopes the subject to the kind and to the organisation", async () => {
      const subjectId = randomUUID();
      await enqueueAs(orgA, { kind: "scope.one", subjectId });
      await expect(enqueueAs(orgA, { kind: "scope.two", subjectId })).resolves.toBeDefined();
      await expect(enqueueAs(orgB, { kind: "scope.one", subjectId })).resolves.toBeDefined();
    });

    it("never treats jobs without a subject as duplicates of each other", async () => {
      await enqueueAs(orgA, { kind: "no.subject", subjectId: null });
      await expect(enqueueAs(orgA, { kind: "no.subject", subjectId: null })).resolves.toBeDefined();
    });
  });

  describe("columns that must stay fixed", () => {
    it.each(["id", "organisation_id", "kind", "subject_id", "max_attempts", "created_at"])(
      "cannot be changed on %s by the application role",
      async (column) => {
        const id = await seed({ organisationId: orgA });
        const value =
          column === "kind"
            ? "'other.kind'"
            : column === "max_attempts"
              ? "7"
              : column === "created_at"
                ? "now()"
                : "gen_random_uuid()";
        expect(
          await sqlStateOf(asApp(orgA, `UPDATE jobs SET ${column} = ${value} WHERE id = $1`, [id])),
        ).toBe("42501");
      },
    );

    it("can change the columns that describe progress", async () => {
      const id = await seed({ organisationId: orgA });
      const token = randomUUID();
      await withTenant(app, orgA, async (client) => {
        const result = await client.query(
          `UPDATE jobs SET status = 'running', attempts = 1, lease_token = $2,
                  available_at = now() + interval '1 minute', last_error_code = 'x'
            WHERE id = $1`,
          [id, token],
        );
        expect(result.rowCount).toBe(1);
      });
    });

    it("cannot be deleted or truncated by the application role", async () => {
      await seed({ organisationId: orgA });
      expect(await sqlStateOf(asApp(orgA, "DELETE FROM jobs"))).toBe("42501");
      expect(await sqlStateOf(asApp(orgA, "TRUNCATE jobs"))).toBe("42501");
    });
  });

  describe("the dispatcher role", () => {
    const dispatch = (sql: string, values: unknown[] = []): Promise<unknown> =>
      dispatcher.query(sql, values);

    it("sees waiting, running and dead jobs of every tenant, but never a succeeded one", async () => {
      const kind = `visible.${randomUUID().slice(0, 8)}`;
      const queuedA = await seed({ organisationId: orgA, kind });
      const queuedB = await seed({ organisationId: orgB, kind });
      const running = await seed({
        organisationId: orgA,
        kind,
        status: "running",
        attempts: 1,
        leaseToken: randomUUID(),
      });
      const dead = await seed({ organisationId: orgB, kind, status: "dead", finished: true });
      await seed({ organisationId: orgA, kind, status: "succeeded", finished: true });

      const seen = await dispatcher.query<{ id: string }>(
        "SELECT id FROM jobs WHERE kind = $1 ORDER BY id",
        [kind],
      );
      expect(seen.rows.map((row) => row.id).sort()).toEqual(
        [queuedA, queuedB, running, dead].sort(),
      );
    });

    it.each(["organisations", "projects", "api_keys", "audit_log", "events", "schema_migrations"])(
      "cannot read %s",
      async (table) => {
        expect(await sqlStateOf(dispatch(`SELECT * FROM ${table}`))).toBe("42501");
      },
    );

    it("cannot write to any other table either", async () => {
      expect(
        await sqlStateOf(
          dispatch("INSERT INTO organisations (id, name) VALUES (gen_random_uuid(), 'x')"),
        ),
      ).toBe("42501");
      expect(await sqlStateOf(dispatch("UPDATE projects SET name = 'x'"))).toBe("42501");
      expect(await sqlStateOf(dispatch("DELETE FROM events"))).toBe("42501");
    });

    it("cannot create, delete or truncate jobs", async () => {
      expect(
        await sqlStateOf(
          dispatch("INSERT INTO jobs (organisation_id, kind) VALUES ($1, 'forged.job')", [orgA]),
        ),
      ).toBe("42501");
      expect(await sqlStateOf(dispatch("DELETE FROM jobs"))).toBe("42501");
      expect(await sqlStateOf(dispatch("TRUNCATE jobs"))).toBe("42501");
    });

    it.each(["id", "organisation_id", "kind", "subject_id", "max_attempts", "created_at"])(
      "cannot change %s of a job",
      async (column) => {
        const id = await seed({ organisationId: orgA });
        const value =
          column === "kind"
            ? "'other.kind'"
            : column === "max_attempts"
              ? "7"
              : column === "created_at"
                ? "now()"
                : "gen_random_uuid()";
        expect(
          await sqlStateOf(dispatch(`UPDATE jobs SET ${column} = ${value} WHERE id = $1`, [id])),
        ).toBe("42501");
      },
    );

    it("can claim a job and give up on one", async () => {
      const claimable = await seed({ organisationId: orgA });
      const token = randomUUID();
      const claimed = await dispatcher.query(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_token = $2,
                available_at = now() + interval '1 minute'
          WHERE id = $1 AND status = 'queued'`,
        [claimable, token],
      );
      expect(claimed.rowCount).toBe(1);

      const doomed = await seed({ organisationId: orgB, status: "queued" });
      const dead = await dispatcher.query(
        `UPDATE jobs SET status = 'dead', lease_token = NULL, finished_at = now(),
                last_error_code = 'lease_expired'
          WHERE id = $1`,
        [doomed],
      );
      expect(dead.rowCount).toBe(1);
    });

    it("cannot mark a job as succeeded or put it back in the queue, only the owning tenant can", async () => {
      const id = await seed({
        organisationId: orgA,
        status: "running",
        attempts: 1,
        leaseToken: randomUUID(),
      });
      expect(
        await sqlStateOf(
          dispatch(
            "UPDATE jobs SET status = 'succeeded', lease_token = NULL, finished_at = now() WHERE id = $1",
            [id],
          ),
        ),
      ).toBe("42501");
      expect(
        await sqlStateOf(
          dispatch("UPDATE jobs SET status = 'queued', lease_token = NULL WHERE id = $1", [id]),
        ),
      ).toBe("42501");
    });

    it.each(["succeeded", "dead"])("cannot touch a %s job", async (status) => {
      const id = await seed({ organisationId: orgA, status, finished: true });
      const result = await dispatcher.query(
        "UPDATE jobs SET status = 'running', lease_token = $2, finished_at = NULL WHERE id = $1",
        [id, randomUUID()],
      );
      expect(result.rowCount).toBe(0);
      const row = await admin.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [
        id,
      ]);
      expect(only(row.rows).status).toBe(status);
    });

    it("gets no extra reach from naming a tenant", async () => {
      // Setting the tenant does not widen what the dispatcher can read: it has no tenant policy
      // on any other table, so projects stay out of reach whatever the setting says.
      const failure = await sqlStateOf(
        (async () => {
          const client = await dispatcher.connect();
          try {
            await client.query("BEGIN");
            await client.query("SELECT set_config('app.organisation_id', $1, true)", [orgA]);
            await client.query("SELECT * FROM projects");
          } finally {
            await client.query("ROLLBACK");
            client.release();
          }
        })(),
      );
      expect(failure).toBe("42501");
    });

    it("cannot become the application role", async () => {
      expect(await sqlStateOf(dispatch("SET ROLE codemugs_app"))).toBe("42501");
    });

    it("cannot change the schema", async () => {
      expect(await sqlStateOf(dispatch("CREATE TABLE sneaky (id int)"))).toBe("42501");
    });
  });
});
