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
  otherProjectId: string;
  apiKeyId: string;
}

describeDatabase("the events table", () => {
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
      const project = async (projectName: string): Promise<string> =>
        only(
          (
            await client.query<{ id: string }>(
              "INSERT INTO projects (organisation_id, name) VALUES ($1, $2) RETURNING id",
              [organisationId, projectName],
            )
          ).rows,
        ).id;
      const projectId = await project("one");
      const otherProjectId = await project("two");
      const key = await client.query<{ id: string }>(
        `INSERT INTO api_keys (organisation_id, project_id, name, secret_hash)
         VALUES ($1, $2, 'key', decode(repeat('ab', 32), 'hex')) RETURNING id`,
        [organisationId, projectId],
      );
      return { organisationId, projectId, otherProjectId, apiKeyId: only(key.rows).id };
    });
  }

  /** Inserts one event as the given tenant, with overrides for the column under test. */
  function insertEvent(
    as: Tenant,
    overrides: Partial<{
      organisationId: string;
      projectId: string;
      eventId: string;
      apiKeyId: string;
      type: string;
      attributes: string;
      schemaVersion: number;
    }> = {},
    tenant: string = as.organisationId,
  ): Promise<unknown> {
    return withTenant(app, tenant, (client) =>
      client.query(
        `INSERT INTO events (organisation_id, project_id, event_id, api_key_id, schema_version,
                             type, occurred_at, environment, sdk_name, sdk_version, attributes)
         VALUES ($1, $2, $3, $4, $5, $6, now(), 'test', 'sdk', '1.0.0', $7::jsonb)`,
        [
          overrides.organisationId ?? as.organisationId,
          overrides.projectId ?? as.projectId,
          overrides.eventId ?? randomUUID(),
          overrides.apiKeyId ?? as.apiKeyId,
          overrides.schemaVersion ?? 1,
          overrides.type ?? "test.event",
          overrides.attributes ?? "{}",
        ],
      ),
    );
  }

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

  const countAs = async (tenant: string | undefined): Promise<number> => {
    if (tenant === undefined) {
      // No tenant set at all: the pool's own connection, outside withTenant.
      return Number(
        only((await app.query<{ n: string }>("SELECT count(*) AS n FROM events")).rows).n,
      );
    }
    return withTenant(app, tenant, async (client) =>
      Number(only((await client.query<{ n: string }>("SELECT count(*) AS n FROM events")).rows).n),
    );
  };

  it("passes the schema guard as an append-only, tenant-scoped table", async () => {
    expect(await findSchemaViolations(admin)).toEqual([]);
  });

  describe("tenant isolation", () => {
    it("shows each tenant only its own events, and nothing when no tenant is set", async () => {
      await insertEvent(a);
      await insertEvent(a);
      await insertEvent(b);

      expect(await countAs(a.organisationId)).toBe(2);
      expect(await countAs(b.organisationId)).toBe(1);
      expect(await countAs(randomUUID())).toBe(0);
      expect(await countAs(undefined)).toBe(0);
    });

    it("refuses an event that claims another organisation than the tenant", async () => {
      expect(
        await sqlStateOf(insertEvent(b, { organisationId: a.organisationId }, b.organisationId)),
      ).toBe("42501");
      expect(await sqlStateOf(insertEvent(a, {}, b.organisationId))).toBe("42501");
    });

    it("refuses an event in another organisation's project", async () => {
      expect(await sqlStateOf(insertEvent(a, { projectId: b.projectId }))).toBe("23503");
    });

    it("refuses an event sent with another organisation's key", async () => {
      expect(await sqlStateOf(insertEvent(a, { apiKeyId: b.apiKeyId }))).toBe("23503");
    });
  });

  describe("idempotency", () => {
    it("rejects the same event id twice in one project", async () => {
      const eventId = randomUUID();
      await insertEvent(a, { eventId });
      expect(await sqlStateOf(insertEvent(a, { eventId }))).toBe("23505");
    });

    it("lets ON CONFLICT DO NOTHING report a duplicate by returning no row", async () => {
      const eventId = randomUUID();
      const insert = (): Promise<number> =>
        withTenant(app, a.organisationId, async (client) => {
          const result = await client.query(
            `INSERT INTO events (organisation_id, project_id, event_id, api_key_id, schema_version,
                                 type, occurred_at, environment, sdk_name, sdk_version)
             VALUES ($1, $2, $3, $4, 1, 't', now(), 'test', 's', '1')
             ON CONFLICT (organisation_id, project_id, event_id) DO NOTHING
             RETURNING event_id`,
            [a.organisationId, a.projectId, eventId, a.apiKeyId],
          );
          return result.rowCount ?? -1;
        });
      expect(await insert()).toBe(1);
      expect(await insert()).toBe(0);
    });

    it("scopes the id to the project and to the organisation", async () => {
      const eventId = randomUUID();
      await insertEvent(a, { eventId });
      // Another project of the same organisation, and another organisation, may reuse the id.
      await expect(insertEvent(a, { eventId, projectId: a.otherProjectId })).resolves.toBeDefined();
      await expect(insertEvent(b, { eventId })).resolves.toBeDefined();
    });
  });

  describe("immutability", () => {
    it("cannot be updated or deleted by the application, even within its own tenant", async () => {
      await insertEvent(a);
      const asA = (sql: string): Promise<unknown> =>
        withTenant(app, a.organisationId, (client) => client.query(sql));
      expect(await sqlStateOf(asA("UPDATE events SET type = 'changed'"))).toBe("42501");
      expect(await sqlStateOf(asA("DELETE FROM events"))).toBe("42501");
      expect(await sqlStateOf(asA("TRUNCATE events"))).toBe("42501");
    });
  });

  describe("bounds", () => {
    it("stores attributes only as a JSON object", async () => {
      expect(await sqlStateOf(insertEvent(a, { attributes: "[]" }))).toBe("23514");
      expect(await sqlStateOf(insertEvent(a, { attributes: "42" }))).toBe("23514");
      expect(await sqlStateOf(insertEvent(a, { attributes: "null" }))).toBe("23514");
      await expect(
        insertEvent(a, { attributes: '{"nested":{"a":[1,2,3]}}' }),
      ).resolves.toBeDefined();
    });

    it("keeps the event type and schema version within bounds", async () => {
      expect(await sqlStateOf(insertEvent(a, { type: "" }))).toBe("23514");
      expect(await sqlStateOf(insertEvent(a, { type: "x".repeat(129) }))).toBe("23514");
      await expect(insertEvent(a, { type: "x".repeat(128) })).resolves.toBeDefined();
      expect(await sqlStateOf(insertEvent(a, { schemaVersion: 0 }))).toBe("23514");
    });
  });

  describe("received time", () => {
    it("is set by the database, not by the client", async () => {
      const eventId = randomUUID();
      await insertEvent(a, { eventId });
      const row = await withTenant(app, a.organisationId, async (client) =>
        only(
          (
            await client.query<{ age_seconds: number }>(
              "SELECT extract(epoch FROM now() - received_at)::float8 AS age_seconds FROM events WHERE event_id = $1",
              [eventId],
            )
          ).rows,
        ),
      );
      expect(row.age_seconds).toBeGreaterThanOrEqual(0);
      expect(row.age_seconds).toBeLessThan(60);
    });
  });
});
