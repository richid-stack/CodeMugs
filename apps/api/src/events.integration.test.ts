import {
  createOrganisation,
  createProject,
  issueApiKey,
  revokeApiKey,
  type IssuedApiKey,
} from "@codemugs/auth";
import { loadApiConfig, Secret } from "@codemugs/configuration";
import { recordEvents } from "@codemugs/ingestion";
import { createPool, type Pool } from "@codemugs/storage";
import { adminDatabaseUrl, createTestDatabase, type TestDatabase } from "@codemugs/storage/testing";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createDatabaseServices } from "./database.js";
import type { EventIngester } from "./ingestion.js";

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
    attributes: { orderId: "o-1", total: 12.5 },
    ...overrides,
  };
}

interface IngestBody {
  accepted: number;
  duplicates: number;
  rejected: number;
  results: Array<{
    index: number;
    eventId?: string;
    status: string;
    reason?: string;
    field?: string;
  }>;
}

describeDatabase("POST /v1/events against PostgreSQL", () => {
  const cleanup: Array<() => Promise<void>> = [];
  let database: TestDatabase;
  let seed: Pool;
  let admin: Pool;
  let orgA: string;
  let orgB: string;
  let projectA: string;
  let projectB: string;
  let keyA: IssuedApiKey;
  let keyB: IssuedApiKey;

  async function start(
    options: { ingester?: EventIngester; lines?: string[] } = {},
  ): Promise<BuiltApp> {
    const services = createDatabaseServices(new Secret(database.appUrl), {
      onError: () => undefined,
    });
    const built = await buildApp({
      config: loadApiConfig({
        NODE_ENV: "test",
        LOG_LEVEL: options.lines === undefined ? "silent" : "debug",
      }),
      readinessChecks: [services.readiness],
      authenticator: services.authenticate,
      ingester: options.ingester ?? services.ingest,
      ...(options.lines === undefined
        ? {}
        : { logStream: { write: (line: string) => options.lines?.push(line) } }),
    });
    cleanup.unshift(async () => {
      await built.app.close();
      await services.close().catch(() => undefined);
    });
    return built;
  }

  const post = (built: BuiltApp, key: string, payload: unknown) =>
    built.app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    });

  async function rows(organisationId: string, eventId?: string) {
    const result = await admin.query(
      `SELECT * FROM events WHERE organisation_id = $1 AND ($2::uuid IS NULL OR event_id = $2)`,
      [organisationId, eventId ?? null],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    cleanup.unshift(() => database.drop());
    seed = createPool({ connectionString: database.appUrl, maxConnections: 2 });
    cleanup.unshift(() => seed.end());
    admin = createPool({ connectionString: database.adminUrl, maxConnections: 2 });
    cleanup.unshift(() => admin.end());

    orgA = (await createOrganisation(seed, { name: "Organisation A" })).id;
    orgB = (await createOrganisation(seed, { name: "Organisation B" })).id;
    projectA = (await createProject(seed, orgA, { name: "alpha", actor: SYSTEM })).id;
    projectB = (await createProject(seed, orgB, { name: "beta", actor: SYSTEM })).id;
    keyA = await issueApiKey(seed, orgA, projectA, { name: "ci", actor: SYSTEM });
    keyB = await issueApiKey(seed, orgB, projectB, { name: "ci", actor: SYSTEM });
  }, 60_000);

  afterAll(async () => {
    for (const close of cleanup) await close();
  });

  it("stores a batch under the key's own organisation, project and key id", async () => {
    const built = await start();
    const events = [event(), event(), event()];

    const response = await post(built, keyA.key, { events });

    expect(response.statusCode).toBe(202);
    expect(response.json<IngestBody>()).toMatchObject({ accepted: 3, duplicates: 0, rejected: 0 });
    for (const sent of events) {
      const [row] = await rows(orgA, sent["eventId"] as string);
      expect(row).toMatchObject({
        organisation_id: orgA,
        project_id: projectA,
        api_key_id: keyA.id,
        type: "checkout.completed",
      });
    }
  });

  it("acknowledges a retry as duplicates and stores nothing twice", async () => {
    const built = await start();
    const events = [event(), event()];
    await post(built, keyA.key, { events });
    const before = (await rows(orgA)).length;

    const again = await post(built, keyA.key, { events });

    expect(again.statusCode).toBe(202);
    expect(again.json<IngestBody>()).toMatchObject({ accepted: 0, duplicates: 2, rejected: 0 });
    expect((await rows(orgA)).length).toBe(before);
  });

  it("keeps two organisations apart, even when they send the same event ids", async () => {
    const built = await start();
    const eventId = randomUUID();

    const fromA = await post(built, keyA.key, { events: [event({ eventId })] });
    const fromB = await post(built, keyB.key, { events: [event({ eventId })] });

    expect(fromA.json<IngestBody>().accepted).toBe(1);
    expect(fromB.json<IngestBody>().accepted).toBe(1);
    expect(await rows(orgA, eventId)).toHaveLength(1);
    expect(await rows(orgB, eventId)).toHaveLength(1);
  });

  it("records under the credential's tenant whatever the request says", async () => {
    const built = await start();
    const eventId = randomUUID();

    const response = await built.app.inject({
      method: "POST",
      url: `/v1/events?organisationId=${orgB}&projectId=${projectB}`,
      headers: {
        authorization: `Bearer ${keyA.key}`,
        "content-type": "application/json",
        "x-organisation-id": orgB,
        "x-project-id": projectB,
      },
      payload: JSON.stringify({
        organisationId: orgB,
        projectId: projectB,
        events: [event({ eventId, organisationId: orgB, projectId: projectB, apiKeyId: keyB.id })],
      }),
    });

    expect(response.statusCode).toBe(202);
    expect(await rows(orgB, eventId)).toEqual([]);
    expect(await rows(orgA, eventId)).toMatchObject([
      { project_id: projectA, api_key_id: keyA.id },
    ]);
  });

  it("refuses a revoked key at once, and stores nothing", async () => {
    const built = await start();
    const key = await issueApiKey(seed, orgA, projectA, { name: "short-lived", actor: SYSTEM });
    const eventId = randomUUID();
    expect((await post(built, key.key, { events: [event()] })).statusCode).toBe(202);

    await revokeApiKey(seed, orgA, key.id, { actor: SYSTEM });
    const response = await post(built, key.key, { events: [event({ eventId })] });

    expect(response.statusCode).toBe(401);
    expect(await rows(orgA, eventId)).toEqual([]);
  });

  describe("events the database could not hold", () => {
    it("are rejected one by one, while the rest of the batch is stored", async () => {
      const built = await start();
      const good = event();
      const hostile = [
        event({ attributes: { text: "before\u0000after" } }),
        event({ attributes: { "key\u0000": 1 } }),
        event({ attributes: { text: "lone \ud800 surrogate" } }),
        event({ occurredAt: "0000-01-01T00:00:00Z" }),
        event({ attributes: JSON.parse('{"deep":' + '{"a":'.repeat(30) + "1" + "}".repeat(31)) }),
      ];

      const response = await post(built, keyA.key, { events: [...hostile, good] });

      expect(response.statusCode).toBe(202);
      const body = response.json<IngestBody>();
      expect(body).toMatchObject({ accepted: 1, rejected: hostile.length });
      expect(body.results.slice(0, -1).map((r) => r.reason)).toEqual([
        "unsupported_value",
        "unsupported_value",
        "unsupported_value",
        "occurred_at_out_of_range",
        "attributes_too_deep",
      ]);
      expect(await rows(orgA, good["eventId"] as string)).toHaveLength(1);
    });

    it("do not become a server error when the document is nested absurdly deep", async () => {
      const built = await start();
      const depth = 40_000;
      const payload =
        `{"events":[${JSON.stringify(event()).slice(0, -1)},"attributes":` +
        '{"a":'.repeat(depth) +
        "1" +
        "}".repeat(depth) +
        "}]}";

      const response = await post(built, keyA.key, payload);

      // Either the JSON parser refuses the document or ingestion rejects the event. Never a 500.
      expect([202, 400]).toContain(response.statusCode);
      if (response.statusCode === 202) {
        expect(response.json<IngestBody>().results[0]).toMatchObject({
          status: "rejected",
          reason: "attributes_too_deep",
        });
      } else {
        expect(response.json<{ error: { code: string } }>().error.code).toBe("invalid_json");
      }
    });
  });

  describe("when the database cannot record events", () => {
    it("answers 500, stores nothing, and the same batch is accepted once it recovers", async () => {
      const closed = createPool({ connectionString: database.appUrl });
      await closed.end();
      const lines: string[] = [];
      const failing = await start({
        lines,
        ingester: (scope, body) => recordEvents(closed, scope, body),
      });
      const events = [event(), event()];

      const first = await post(failing, keyA.key, { events });

      expect(first.statusCode).toBe(500);
      expect(first.json<{ error: { code: string } }>().error.code).toBe("internal_error");
      expect(first.body).not.toContain("127.0.0.1");
      for (const sent of events) {
        expect(await rows(orgA, sent["eventId"] as string)).toEqual([]);
      }

      const healthy = await start();
      const second = await post(healthy, keyA.key, { events });
      expect(second.statusCode).toBe(202);
      expect(second.json<IngestBody>()).toMatchObject({ accepted: 2, duplicates: 0 });
    });

    // A real PostgreSQL data exception quotes the JSON that failed in its context, which for an
    // event is customer data. This sends one through the whole stack, with an ingester that
    // skips validation, to show it never reaches the log. (A constraint violation on this table
    // is not a case: forced row-level security makes PostgreSQL leave the row out of its error.)
    it("never logs customer data that a database error quotes", async () => {
      const canary = "CANARY-CUSTOMER-DATA-7f3a";
      const lines: string[] = [];
      const failingStatement = (): Promise<unknown> =>
        seed.query("SELECT $1::jsonb", [JSON.stringify({ note: `${canary}\u0000` })]);
      const leaky: EventIngester = async () => {
        await failingStatement();
        throw new Error("the statement was expected to fail");
      };

      // The precondition: PostgreSQL really does put the canary in the error object.
      const raw = await failingStatement().then(
        () => undefined,
        (error: unknown) => error as Record<string, unknown>,
      );
      expect(raw?.["code"]).toBe("22P05");
      expect(JSON.stringify({ ...raw, message: (raw as unknown as Error).message })).toContain(
        canary,
      );

      const built = await start({ lines, ingester: leaky });
      const response = await post(built, keyA.key, { events: [event()] });

      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain(canary);
      const log = lines.join("\n");
      expect(log).toContain("unhandled error");
      expect(log).toContain("22P05");
      expect(log).not.toContain(canary);
    });
  });
});
