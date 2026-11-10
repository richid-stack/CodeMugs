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

interface Tenant {
  organisationId: string;
  projectId: string;
  apiKeyId: string;
}

describeDatabase("event processing tables", () => {
  const cleanup: Array<() => Promise<void>> = [];
  let database: TestDatabase;
  let app: Pool;
  let admin: Pool;
  let a: Tenant;
  let b: Tenant;

  async function createTenant(name: string): Promise<Tenant> {
    const organisationId = randomUUID();
    return withTenant(app, organisationId, async (client) => {
      await client.query("INSERT INTO organisations (id, name) VALUES ($1, $2)", [
        organisationId,
        name,
      ]);
      const project = await client.query<{ id: string }>(
        "INSERT INTO projects (organisation_id, name) VALUES ($1, 'p') RETURNING id",
        [organisationId],
      );
      const projectId = only(project.rows).id;
      const key = await client.query<{ id: string }>(
        `INSERT INTO api_keys (organisation_id, project_id, name, secret_hash)
         VALUES ($1, $2, 'key', decode(repeat('ab', 32), 'hex')) RETURNING id`,
        [organisationId, projectId],
      );
      return { organisationId, projectId, apiKeyId: only(key.rows).id };
    });
  }

  /** Inserts a count as the tenant, with the bucket and count under test. */
  function insertAggregate(
    as: Tenant,
    bucket: string,
    count = 1,
    overrides: { organisationId?: string; projectId?: string } = {},
    tenant: string = as.organisationId,
  ): Promise<unknown> {
    return withTenant(app, tenant, (client) =>
      client.query(
        `INSERT INTO event_aggregates (organisation_id, project_id, bucket_start, event_count)
         VALUES ($1, $2, $3::timestamptz, $4)`,
        [
          overrides.organisationId ?? as.organisationId,
          overrides.projectId ?? as.projectId,
          bucket,
          count,
        ],
      ),
    );
  }

  const asTenant = (tenant: string, sql: string, values: unknown[] = []): Promise<unknown> =>
    withTenant(app, tenant, (client) => client.query(sql, values));

  beforeAll(async () => {
    database = await createTestDatabase();
    cleanup.unshift(() => database.drop());
    app = createPool({ connectionString: database.appUrl, maxConnections: 4 });
    cleanup.unshift(() => app.end());
    admin = createPool({ connectionString: database.adminUrl, maxConnections: 2 });
    cleanup.unshift(() => admin.end());
    a = await createTenant("A");
    b = await createTenant("B");
  }, 60_000);

  afterAll(async () => {
    for (const close of cleanup) await close();
  });

  it("passes the schema guard", async () => {
    expect(await findSchemaViolations(admin)).toEqual([]);
  });

  describe("event_aggregates", () => {
    it("shows each tenant only its own counts, and nothing when no tenant is set", async () => {
      await insertAggregate(a, "2026-01-01T00:00:00Z", 5);
      await insertAggregate(a, "2026-01-01T01:00:00Z", 6);
      await insertAggregate(b, "2026-01-01T00:00:00Z", 7);
      const count = (tenant: string): Promise<number> =>
        withTenant(app, tenant, async (client) =>
          Number(
            only(
              (await client.query<{ n: string }>("SELECT count(*) AS n FROM event_aggregates"))
                .rows,
            ).n,
          ),
        );
      expect(await count(a.organisationId)).toBe(2);
      expect(await count(b.organisationId)).toBe(1);
      expect(await count(randomUUID())).toBe(0);
      const outside = await app.query<{ n: string }>("SELECT count(*) AS n FROM event_aggregates");
      expect(Number(only(outside.rows).n)).toBe(0);
    });

    it("refuses a count that names another organisation than the tenant", async () => {
      expect(
        await sqlStateOf(
          insertAggregate(
            b,
            "2026-02-01T00:00:00Z",
            1,
            { organisationId: a.organisationId },
            b.organisationId,
          ),
        ),
      ).toBe("42501");
    });

    it("refuses a count for another organisation's project", async () => {
      expect(
        await sqlStateOf(insertAggregate(a, "2026-02-01T00:00:00Z", 1, { projectId: b.projectId })),
      ).toBe("23503");
    });

    it("keeps one row per project per hour, and lets the processing job replace it", async () => {
      await insertAggregate(a, "2026-03-01T00:00:00Z", 1);
      expect(await sqlStateOf(insertAggregate(a, "2026-03-01T00:00:00Z", 2))).toBe("23505");

      // What the processing job does: write the recomputed count, whether or not a row exists.
      const upsert = (count: number): Promise<unknown> =>
        asTenant(
          a.organisationId,
          `INSERT INTO event_aggregates (organisation_id, project_id, bucket_start, event_count)
           VALUES ($1, $2, '2026-03-01T00:00:00Z', $3)
           ON CONFLICT (organisation_id, project_id, bucket_start)
           DO UPDATE SET event_count = EXCLUDED.event_count, updated_at = now()`,
          [a.organisationId, a.projectId, count],
        );
      await upsert(9);
      await upsert(9);
      const row = only(
        (
          await admin.query<{ event_count: string }>(
            "SELECT event_count FROM event_aggregates WHERE project_id = $1 AND bucket_start = '2026-03-01T00:00:00Z'",
            [a.projectId],
          )
        ).rows,
      );
      expect(row.event_count).toBe("9");
    });

    it("only holds whole hours in UTC, however the time is written", async () => {
      expect(await sqlStateOf(insertAggregate(a, "2026-04-01T10:30:00Z"))).toBe("23514");
      expect(await sqlStateOf(insertAggregate(a, "2026-04-01T10:00:00.5Z"))).toBe("23514");
      expect(await sqlStateOf(insertAggregate(a, "2026-04-01T10:00:01Z"))).toBe("23514");
      // The same instant as 10:00 UTC, written in zones that are not on the hour in UTC terms.
      await expect(insertAggregate(a, "2026-04-01T15:30:00+05:30")).resolves.toBeDefined();
      await expect(insertAggregate(a, "2026-04-01T12:00:00+02:00")).rejects.toMatchObject({
        code: "23505",
      });
    });

    it("never holds a negative count", async () => {
      expect(await sqlStateOf(insertAggregate(a, "2026-05-01T00:00:00Z", -1))).toBe("23514");
      await expect(insertAggregate(a, "2026-05-01T00:00:00Z", 0)).resolves.toBeDefined();
    });

    it("lets the application change the count, and nothing that says whose it is", async () => {
      await insertAggregate(a, "2026-06-01T00:00:00Z", 1);
      const where = "WHERE bucket_start = '2026-06-01T00:00:00Z'";
      await expect(
        asTenant(
          a.organisationId,
          `UPDATE event_aggregates SET event_count = 2, updated_at = now() ${where}`,
        ),
      ).resolves.toBeDefined();
      for (const change of [
        "bucket_start = '2026-06-01T01:00:00Z'",
        "project_id = gen_random_uuid()",
        "organisation_id = gen_random_uuid()",
      ]) {
        expect(
          await sqlStateOf(
            asTenant(a.organisationId, `UPDATE event_aggregates SET ${change} ${where}`),
          ),
        ).toBe("42501");
      }
    });

    it("cannot be deleted or truncated by the application", async () => {
      expect(await sqlStateOf(asTenant(a.organisationId, "DELETE FROM event_aggregates"))).toBe(
        "42501",
      );
      expect(await sqlStateOf(asTenant(a.organisationId, "TRUNCATE event_aggregates"))).toBe(
        "42501",
      );
    });

    it("cannot be read by the dispatcher", async () => {
      const dispatcher = createPool({
        connectionString: database.dispatcherUrl,
        maxConnections: 1,
      });
      try {
        expect(await sqlStateOf(dispatcher.query("SELECT * FROM event_aggregates"))).toBe("42501");
      } finally {
        await dispatcher.end();
      }
    });
  });

  describe("events.batch_id", () => {
    function insertEvent(batchId: string | null): Promise<unknown> {
      return withTenant(app, a.organisationId, (client) =>
        client.query(
          `INSERT INTO events (organisation_id, project_id, event_id, api_key_id, schema_version, type,
                               occurred_at, environment, sdk_name, sdk_version, batch_id)
           VALUES ($1, $2, gen_random_uuid(), $3, 1, 't', now(), 'test', 's', '1', $4)`,
          [a.organisationId, a.projectId, a.apiKeyId, batchId],
        ),
      );
    }

    it("is stored with the event, and may be absent for events from before batches", async () => {
      const batchId = randomUUID();
      await insertEvent(batchId);
      await insertEvent(null);
      const rows = await admin.query<{ n: string }>(
        "SELECT count(*) AS n FROM events WHERE batch_id = $1",
        [batchId],
      );
      expect(rows.rows[0]?.n).toBe("1");
    });

    it("cannot be changed afterwards, like the rest of the event", async () => {
      expect(
        await sqlStateOf(
          asTenant(a.organisationId, "UPDATE events SET batch_id = gen_random_uuid()"),
        ),
      ).toBe("42501");
    });

    it("has an index for looking a batch up within one tenant", async () => {
      const index = await admin.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'events_batch_idx'",
      );
      expect(only(index.rows).indexdef).toContain("(organisation_id, batch_id)");
    });
  });
});
