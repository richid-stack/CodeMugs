import {
  createOrganisation,
  createProject,
  issueApiKey,
  revokeApiKey,
  type IssuedApiKey,
} from "@codemugs/auth";
import { loadApiConfig, Secret } from "@codemugs/configuration";
import { createPool, type Pool } from "@codemugs/storage";
import { adminDatabaseUrl, createTestDatabase, type TestDatabase } from "@codemugs/storage/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createDatabaseServices, type DatabaseServices } from "./database.js";

const describeDatabase = adminDatabaseUrl() === undefined ? describe.skip : describe;

const SYSTEM = { type: "system" } as const;
const quiet = loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

describeDatabase("the API against PostgreSQL", () => {
  const cleanup: Array<() => Promise<void>> = [];
  let database: TestDatabase;
  let seed: Pool;
  let orgA: string;
  let orgB: string;
  let projectA: string;
  let projectB: string;
  let keyA: IssuedApiKey;
  let keyB: IssuedApiKey;

  /** The real wiring: the same code main.ts uses, pointed at the test database. */
  async function start(
    url: string,
    options: { logLevel?: string; lines?: string[] } = {},
  ): Promise<{ built: BuiltApp; services: DatabaseServices }> {
    const services = createDatabaseServices(new Secret(url), { onError: () => undefined });
    const built = await buildApp({
      config:
        options.logLevel === undefined
          ? quiet
          : loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: options.logLevel }),
      readinessChecks: [services.readiness],
      authenticator: services.authenticate,
      ...(options.lines === undefined
        ? {}
        : { logStream: { write: (line: string) => options.lines?.push(line) } }),
    });
    cleanup.unshift(async () => {
      await built.app.close();
      await services.close().catch(() => undefined);
    });
    return { built, services };
  }

  const whoami = (built: BuiltApp, key: string | undefined, extra = "") =>
    built.app.inject({
      method: "GET",
      url: `/v1/whoami${extra}`,
      headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
    });

  beforeAll(async () => {
    database = await createTestDatabase();
    cleanup.unshift(() => database.drop());
    seed = createPool({ connectionString: database.appUrl, maxConnections: 2 });
    cleanup.unshift(() => seed.end());

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

  describe("a real key", () => {
    it("returns the organisation and project it was issued for, and each key its own", async () => {
      const { built } = await start(database.appUrl);

      const a = await whoami(built, keyA.key);
      expect(a.statusCode).toBe(200);
      expect(a.json()).toEqual({ organisationId: orgA, projectId: projectA, apiKeyId: keyA.id });

      const b = await whoami(built, keyB.key);
      expect(b.statusCode).toBe(200);
      expect(b.json()).toEqual({ organisationId: orgB, projectId: projectB, apiKeyId: keyB.id });
    });

    it("ignores every attempt to name a different tenant", async () => {
      const { built } = await start(database.appUrl);
      const response = await built.app.inject({
        method: "GET",
        url: `/v1/whoami?organisationId=${orgB}&projectId=${projectB}`,
        headers: {
          authorization: `Bearer ${keyA.key}`,
          "x-organisation-id": orgB,
          "x-project-id": projectB,
          "x-tenant-id": orgB,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        organisationId: orgA,
        projectId: projectA,
        apiKeyId: keyA.id,
      });
    });

    it("is refused when the key claims another organisation's id", async () => {
      const { built } = await start(database.appUrl);
      const forged = `cmk_${orgB.replaceAll("-", "")}_${keyA.key.slice(37)}`;
      expect(forged).toHaveLength(keyA.key.length);
      expect((await whoami(built, forged)).statusCode).toBe(401);
    });

    it("is refused when the secret is wrong", async () => {
      const { built } = await start(database.appUrl);
      const wrong = `${keyA.key.slice(0, 70)}${"A".repeat(43)}`;
      expect(wrong).toHaveLength(keyA.key.length);
      expect((await whoami(built, wrong)).statusCode).toBe(401);
    });

    it("stops working the moment it is revoked, with the same answer as any other bad key", async () => {
      const { built } = await start(database.appUrl);
      const key = await issueApiKey(seed, orgA, projectA, { name: "short-lived", actor: SYSTEM });

      expect((await whoami(built, key.key)).statusCode).toBe(200);
      expect(await revokeApiKey(seed, orgA, key.id, { actor: SYSTEM })).toBe(true);

      const revoked = await whoami(built, key.key);
      const unknown = await whoami(built, `${key.key.slice(0, 70)}${"B".repeat(43)}`);
      expect(revoked.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      const shape = (r: typeof revoked) => {
        const { error } = r.json<ErrorBody>();
        return { code: error.code, message: error.message };
      };
      expect(shape(revoked)).toEqual(shape(unknown));
    });

    it("never reaches the log, which names the caller instead", async () => {
      const lines: string[] = [];
      const { built } = await start(database.appUrl, { logLevel: "debug", lines });
      const secret = keyA.key.slice(70);

      await whoami(built, keyA.key);
      await whoami(built, `${keyA.key.slice(0, 70)}${"C".repeat(43)}`);

      const log = lines.join("\n");
      expect(lines.length).toBeGreaterThan(0);
      expect(log).not.toContain(keyA.key);
      expect(log).not.toContain(secret);
      expect(log).not.toContain(database.appUrl);
      expect(log).toContain(keyA.id);
    });
  });

  describe("readiness", () => {
    it("is ready when the database is migrated and reachable", async () => {
      const { built } = await start(database.appUrl);
      const response = await built.app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready", checks: { database: "ok" } });
    });

    it("is not ready when the database has not been migrated", async () => {
      const empty = await createTestDatabase({ migrate: false });
      cleanup.unshift(() => empty.drop());
      const { built } = await start(empty.appUrl);
      const response = await built.app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "unavailable", checks: { database: "fail" } });
    });
  });

  describe("when the database cannot answer", () => {
    it("answers 500, never 401, once the connection pool is closed", async () => {
      const { built, services } = await start(database.appUrl);
      expect((await whoami(built, keyA.key)).statusCode).toBe(200);

      await services.close();

      const response = await whoami(built, keyA.key);
      expect(response.statusCode).toBe(500);
      expect(response.json<ErrorBody>().error.code).toBe("internal_error");
      expect((await built.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
      expect((await built.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
    });

    it("answers 500 and exposes nothing when the database is unreachable", async () => {
      const lines: string[] = [];
      const url = "postgres://codemugs_app:unreachable-pw-123@127.0.0.1:1/nothing";
      const { built } = await start(url, { logLevel: "debug", lines });

      const response = await whoami(built, keyA.key);

      expect(response.statusCode).toBe(500);
      expect(response.json<ErrorBody>().error.code).toBe("internal_error");
      expect(response.body).not.toContain("127.0.0.1");
      expect(response.body).not.toContain("unreachable-pw-123");
      expect(response.body).not.toContain("ECONNREFUSED");
      // The cause is for operators, and even there the credentials stay out.
      const log = lines.join("\n");
      expect(log).toContain("unhandled error");
      expect(log).not.toContain("unreachable-pw-123");
      expect(log).not.toContain(keyA.key);
    });
  });
});
