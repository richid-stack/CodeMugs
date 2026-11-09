import { randomUUID } from "node:crypto";
import { createOrganisation, createProject, issueApiKey } from "@codemugs/auth";
import { createPool, type Pool } from "@codemugs/storage";
import { adminDatabaseUrl, createTestDatabase, type TestDatabase } from "@codemugs/storage/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordEvents, type IngestResult, type IngestScope } from "./record.js";

const describeDatabase = adminDatabaseUrl() === undefined ? describe.skip : describe;
const SYSTEM = { type: "system" } as const;

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    type: "checkout.completed",
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    environment: "production",
    sdk: { name: "sdk-js", version: "1.2.3" },
    attributes: { orderId: "o-1", total: 12.5, items: [1, 2, 3], nested: { ok: true } },
    ...overrides,
  };
}

function only<T>(rows: T[]): T {
  if (rows.length !== 1) throw new Error(`expected one row but got ${rows.length}`);
  return rows[0] as T;
}

function resultOf(outcome: Awaited<ReturnType<typeof recordEvents>>): IngestResult {
  if (!outcome.ok) throw new Error(`the batch was refused: ${outcome.error}`);
  return outcome.result;
}

interface Tenant extends IngestScope {
  name: string;
}

describeDatabase("recording events in PostgreSQL", () => {
  const cleanup: Array<() => Promise<void>> = [];
  let database: TestDatabase;
  let app: Pool;
  let admin: Pool;
  let a: Tenant;
  let b: Tenant;

  async function tenant(name: string): Promise<Tenant> {
    const organisationId = (await createOrganisation(app, { name })).id;
    const projectId = (await createProject(app, organisationId, { name: "p", actor: SYSTEM })).id;
    const key = await issueApiKey(app, organisationId, projectId, { name: "k", actor: SYSTEM });
    return { name, organisationId, projectId, apiKeyId: key.id };
  }

  const record = async (scope: IngestScope, events: unknown[]): Promise<IngestResult> =>
    resultOf(await recordEvents(app, scope, { events }));

  async function stored(scope: IngestScope, eventId?: string) {
    const result = await admin.query(
      `SELECT * FROM events WHERE organisation_id = $1 AND project_id = $2
         AND ($3::uuid IS NULL OR event_id = $3) ORDER BY event_id`,
      [scope.organisationId, scope.projectId, eventId ?? null],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    cleanup.unshift(() => database.drop());
    app = createPool({ connectionString: database.appUrl, maxConnections: 8 });
    cleanup.unshift(() => app.end());
    admin = createPool({ connectionString: database.adminUrl, maxConnections: 2 });
    cleanup.unshift(() => admin.end());
    a = await tenant("A");
    b = await tenant("B");
  }, 60_000);

  afterAll(async () => {
    for (const close of cleanup) await close();
  });

  describe("a good batch", () => {
    it("is stored, and every event is reported accepted in the order it was sent", async () => {
      const events = [event(), event(), event()];
      const result = await record(a, events);

      expect(result).toMatchObject({ accepted: 3, duplicates: 0, rejected: 0 });
      expect(result.results).toEqual(
        events.map((sent, index) => ({ index, eventId: sent["eventId"], status: "accepted" })),
      );
      expect((await stored(a)).length).toBeGreaterThanOrEqual(3);
    });

    it("keeps what was sent, in the form it is stored", async () => {
      const eventId = randomUUID();
      await record(a, [
        event({
          eventId,
          type: "error.captured",
          occurredAt: "2026-11-07T22:00:00.123456+14:00",
          environment: "staging",
          sdk: { name: "sdk-py", version: "0.9.1" },
          attributes: { message: "boom", list: [1, "two", null, { three: 3 }], emoji: "😀" },
        }),
      ]);

      const row = only(await stored(a, eventId));
      expect(row).toMatchObject({
        organisation_id: a.organisationId,
        project_id: a.projectId,
        api_key_id: a.apiKeyId,
        schema_version: 1,
        type: "error.captured",
        environment: "staging",
        sdk_name: "sdk-py",
        sdk_version: "0.9.1",
        attributes: { message: "boom", list: [1, "two", null, { three: 3 }], emoji: "😀" },
      });
      // The offset is folded into UTC and the precision is milliseconds.
      expect((row["occurred_at"] as Date).toISOString()).toBe("2026-11-07T08:00:00.123Z");
      expect(row["received_at"]).toBeInstanceOf(Date);
    });

    it("takes the tenant from the scope, and ignores anything in the request that names one", async () => {
      const eventId = randomUUID();
      const outcome = await recordEvents(app, a, {
        organisationId: b.organisationId,
        projectId: b.projectId,
        events: [
          event({
            eventId,
            organisationId: b.organisationId,
            projectId: b.projectId,
            apiKeyId: b.apiKeyId,
            tenantId: b.organisationId,
          }),
        ],
      });
      expect(resultOf(outcome).accepted).toBe(1);
      expect(only(await stored(a, eventId))["project_id"]).toBe(a.projectId);
      expect(await stored(b, eventId)).toEqual([]);
    });

    it("stores the largest allowed batch", async () => {
      const events = Array.from({ length: 500 }, () => event());
      const started = Date.now();
      const result = await record(b, events);
      expect(result).toMatchObject({ accepted: 500, duplicates: 0, rejected: 0 });
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  });

  describe("retries", () => {
    it("acknowledges a repeated batch as duplicates and stores nothing twice", async () => {
      const events = [event(), event(), event()];
      await record(a, events);
      const before = (await stored(a)).length;

      const again = await record(a, events);

      expect(again).toMatchObject({ accepted: 0, duplicates: 3, rejected: 0 });
      expect(again.results.map((r) => r.status)).toEqual(["duplicate", "duplicate", "duplicate"]);
      expect((await stored(a)).length).toBe(before);
    });

    it("stores only the new events of a batch that partly repeats", async () => {
      const old = [event(), event()];
      await record(a, old);
      const fresh = [event(), event()];

      const result = await record(a, [old[0], fresh[0], old[1], fresh[1]]);

      expect(result.results.map((r) => r.status)).toEqual([
        "duplicate",
        "accepted",
        "duplicate",
        "accepted",
      ]);
    });

    it("keeps the first copy when a retry carries different content", async () => {
      const eventId = randomUUID();
      await record(a, [event({ eventId, attributes: { version: "first" } })]);
      const again = await record(a, [event({ eventId, attributes: { version: "second" } })]);

      expect(again.duplicates).toBe(1);
      expect(only(await stored(a, eventId))["attributes"]).toEqual({ version: "first" });
    });

    it("stores one copy of an id that appears twice in the same batch, in either letter case", async () => {
      const eventId = randomUUID();
      const result = await record(a, [
        event({ eventId }),
        event({ eventId: eventId.toUpperCase() }),
        event({ eventId }),
      ]);

      expect(result.results.map((r) => r.status)).toEqual(["accepted", "duplicate", "duplicate"]);
      expect(await stored(a, eventId)).toHaveLength(1);
    });

    it("reports an id sent in upper case as accepted, and its retry as a duplicate", async () => {
      // PostgreSQL hands the id back in lower case, so the two forms must be matched.
      const eventId = randomUUID().toUpperCase();
      const first = await record(a, [event({ eventId })]);
      expect(first.results).toEqual([{ index: 0, eventId, status: "accepted" }]);

      const retry = await record(a, [event({ eventId: eventId.toLowerCase() })]);
      expect(retry).toMatchObject({ accepted: 0, duplicates: 1 });
      expect(await stored(a, eventId.toLowerCase())).toHaveLength(1);
    });

    it("stores one copy when the upper-case form comes first in the batch", async () => {
      const eventId = randomUUID();
      const result = await record(a, [
        event({ eventId: eventId.toUpperCase() }),
        event({ eventId }),
      ]);
      expect(result.results.map((r) => r.status)).toEqual(["accepted", "duplicate"]);
      expect(await stored(a, eventId)).toHaveLength(1);
    });

    it("treats an id as belonging to its project's organisation, not to everyone", async () => {
      const eventId = randomUUID();
      expect((await record(a, [event({ eventId })])).accepted).toBe(1);
      expect((await record(b, [event({ eventId })])).accepted).toBe(1);
      expect(await stored(a, eventId)).toHaveLength(1);
      expect(await stored(b, eventId)).toHaveLength(1);
    });

    it("reports each event once when the same batch is sent twice at the same moment", async () => {
      const events = Array.from({ length: 100 }, () => event());
      const [first, second] = await Promise.all([record(a, events), record(a, events)]);

      expect(first.accepted + second.accepted).toBe(100);
      expect(first.duplicates + second.duplicates).toBe(100);
      expect(first.rejected + second.rejected).toBe(0);
      for (const { eventId } of first.results as Array<{ eventId: string }>) {
        expect(await stored(a, eventId)).toHaveLength(1);
      }
    });

    it("does not deadlock when overlapping batches arrive in opposite orders", async () => {
      // Without a fixed insertion order, two transactions that insert the same keys in opposite
      // orders wait for each other and one is killed with SQLSTATE 40P01.
      for (let round = 0; round < 15; round += 1) {
        const events = Array.from({ length: 150 }, () => event());
        const outcomes = await Promise.allSettled([
          record(a, events),
          record(a, [...events].reverse()),
          record(
            a,
            [...events].sort(() => Math.random() - 0.5),
          ),
        ]);
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") throw outcome.reason as Error;
        }
        const total = outcomes.reduce(
          (sum, outcome) => sum + (outcome as PromiseFulfilledResult<IngestResult>).value.accepted,
          0,
        );
        expect(total).toBe(150);
      }
    }, 60_000);
  });

  describe("events that cannot be accepted", () => {
    it("rejects them one by one and stores the rest of the batch", async () => {
      const good1 = event();
      const good2 = event();
      const badId = randomUUID();
      const result = await record(a, [
        good1,
        null,
        event({ eventId: badId, environment: "nope" }),
        event({ eventId: "not-a-uuid" }),
        good2,
      ]);

      expect(result).toMatchObject({ accepted: 2, duplicates: 0, rejected: 3 });
      expect(result.results).toEqual([
        { index: 0, eventId: good1["eventId"], status: "accepted" },
        { index: 1, status: "rejected", reason: "not_an_object" },
        {
          index: 2,
          eventId: badId,
          status: "rejected",
          reason: "invalid_event",
          field: "environment",
        },
        { index: 3, status: "rejected", reason: "invalid_event", field: "eventId" },
        { index: 4, eventId: good2["eventId"], status: "accepted" },
      ]);
      expect(await stored(a, badId)).toEqual([]);
    });

    it("never lets a value the database cannot hold reach the database", async () => {
      // Each of these is valid to the schema, and each would make PostgreSQL fail. If one got
      // through, the whole batch would fail with a 500 and be retried for ever.
      const deep: Record<string, unknown> = {};
      let cursor = deep;
      for (let i = 0; i < 60; i += 1) {
        const next: Record<string, unknown> = {};
        cursor["a"] = next;
        cursor = next;
      }
      const hostile = [
        event({ attributes: { text: "before\u0000after" } }),
        event({ attributes: { "key\u0000": 1 } }),
        event({ attributes: { text: "lone \ud800 surrogate" } }),
        event({ sdk: { name: "bad\u0000sdk", version: "1" } }),
        event({ occurredAt: "0000-01-01T00:00:00Z" }),
        event({ occurredAt: "9999-12-31T23:59:59Z" }),
        event({ attributes: deep }),
        event({ attributes: JSON.parse('{"big": 1e999}') as unknown }),
      ];
      const good = event();

      const result = await record(a, [...hostile, good]);

      expect(result.rejected).toBe(hostile.length);
      expect(result.accepted).toBe(1);
      expect(result.results.at(-1)).toMatchObject({ status: "accepted" });
      expect(await stored(a, good["eventId"] as string)).toHaveLength(1);
    });

    it("makes no database call at all when nothing in the batch is acceptable", async () => {
      const closed = createPool({ connectionString: database.appUrl });
      await closed.end();
      // A closed pool throws on any query, so reaching the result proves there was no query.
      const outcome = await recordEvents(closed, a, { events: [null, 1, "x"] });
      expect(resultOf(outcome)).toMatchObject({ accepted: 0, duplicates: 0, rejected: 3 });
    });
  });

  describe("a batch that is refused as a whole", () => {
    it.each([
      ["an array", [event()], "body_not_an_object"],
      ["no events", {}, "events_missing"],
      ["an empty batch", { events: [] }, "events_empty"],
      [
        "too many events",
        { events: Array.from({ length: 501 }, () => event()) },
        "too_many_events",
      ],
    ])("refuses %s", async (_label, body, error) => {
      expect(await recordEvents(app, a, body)).toEqual({ ok: false, error });
    });
  });

  describe("when the database fails", () => {
    it("throws, rather than reporting events as rejected, so the client retries", async () => {
      const closed = createPool({ connectionString: database.appUrl });
      await closed.end();
      await expect(recordEvents(closed, a, { events: [event()] })).rejects.toThrow();
    });

    it("stores nothing from the batch, because it is one statement", async () => {
      const events = [event(), event(), event()];
      // A key that does not exist makes the insert fail on its foreign key.
      const wrongKey: IngestScope = { ...a, apiKeyId: randomUUID() };
      await expect(recordEvents(app, wrongKey, { events })).rejects.toThrow();
      for (const sent of events) {
        expect(await stored(a, sent["eventId"] as string)).toEqual([]);
      }
    });

    it("cannot be pointed at another organisation's project", async () => {
      const crossed: IngestScope = { ...a, projectId: b.projectId };
      await expect(recordEvents(app, crossed, { events: [event()] })).rejects.toThrow();
    });
  });
});
