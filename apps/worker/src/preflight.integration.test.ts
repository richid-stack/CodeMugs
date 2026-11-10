import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { createPool, type Pool } from "@codemugs/storage";
import {
  adminDatabaseUrl,
  APP_ROLE,
  createTestDatabase,
  DISPATCHER_ROLE,
  type TestDatabase,
} from "@codemugs/storage/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { verifyDatabase, WorkerStartupError } from "./preflight.js";

const describeDatabase = adminDatabaseUrl() === undefined ? describe.skip : describe;

/** The connection string with another database, user, host or port. */
function rewrite(
  base: string,
  changes: { database?: string; user?: string; host?: string; port?: string },
): string {
  const url = new URL(base);
  if (changes.database !== undefined) url.pathname = `/${changes.database}`;
  if (changes.user !== undefined) url.username = changes.user;
  if (changes.host !== undefined) url.hostname = changes.host;
  if (changes.port !== undefined) url.port = changes.port;
  return url.toString();
}

async function failureOf(work: Promise<unknown>): Promise<WorkerStartupError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof WorkerStartupError) return error;
    throw error;
  }
  throw new Error("expected the check to fail");
}

describeDatabase("checking the database before the worker takes jobs", () => {
  const pools: Pool[] = [];
  const roles: string[] = [];
  const databases: string[] = [];
  let database: TestDatabase;
  let admin: Pool;
  let password: string;

  const pool = (connectionString: string): Pool => {
    const created = createPool({ connectionString, maxConnections: 1, connectionTimeoutMs: 3_000 });
    pools.push(created);
    return created;
  };
  const appPool = (): Pool => pool(database.appUrl);
  const dispatcherPool = (): Pool => pool(database.dispatcherUrl);

  /** A role with the given attributes, to stand in for a runtime role that has too much power. */
  async function throwawayRole(attributes: string): Promise<{ name: string; url: string }> {
    const name = `cm_pf_${randomBytes(6).toString("hex")}`;
    // The password is the throwaway one the test roles already use, and only [A-Za-z0-9_].
    await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' ${attributes}`);
    roles.push(name);
    return { name, url: rewrite(database.appUrl, { user: name }) };
  }

  async function emptyDatabase(): Promise<string> {
    const name = `cm_pf_${randomBytes(6).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${name}`);
    databases.push(name);
    return name;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    admin = createPool({ connectionString: database.adminUrl, maxConnections: 2 });
    password = decodeURIComponent(new URL(database.appUrl).password);
  }, 60_000);

  afterEach(async () => {
    for (const created of pools.splice(0)) await created.end();
  });

  afterAll(async () => {
    for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    for (const name of roles) await admin.query(`DROP ROLE IF EXISTS ${name}`);
    await admin.end();
    await database.drop();
  });

  it("passes for the application role and the dispatcher role on a migrated database", async () => {
    await expect(
      verifyDatabase({ app: appPool(), dispatcher: dispatcherPool() }),
    ).resolves.toBeUndefined();
  });

  describe("the roles", () => {
    it("refuses the dispatcher connection when it is really the application role", async () => {
      // The nasty case: the application role sees no jobs, so a worker would idle for ever.
      const error = await failureOf(verifyDatabase({ app: appPool(), dispatcher: appPool() }));
      expect(error).toMatchObject({ code: "wrong_role", variable: "DISPATCHER_DATABASE_URL" });
    });

    it("refuses the application connection when it is really the dispatcher role", async () => {
      const error = await failureOf(
        verifyDatabase({ app: dispatcherPool(), dispatcher: dispatcherPool() }),
      );
      expect(error).toMatchObject({ code: "wrong_role", variable: "DATABASE_URL" });
    });

    it("refuses a superuser on either connection", async () => {
      const superuser = (): Pool => pool(database.adminUrl);
      expect(
        await failureOf(verifyDatabase({ app: superuser(), dispatcher: dispatcherPool() })),
      ).toMatchObject({ code: "wrong_role", variable: "DATABASE_URL" });
      expect(
        await failureOf(verifyDatabase({ app: appPool(), dispatcher: superuser() })),
      ).toMatchObject({ code: "wrong_role", variable: "DISPATCHER_DATABASE_URL" });
    });

    it.each(["SUPERUSER", "BYPASSRLS", "CREATEROLE", "CREATEDB", "REPLICATION"])(
      "refuses a runtime role that has been given %s",
      async (attribute) => {
        const role = await throwawayRole(attribute);
        const names = { app: role.name, dispatcher: DISPATCHER_ROLE };
        const asApp = await failureOf(
          verifyDatabase({ app: pool(role.url), dispatcher: dispatcherPool() }, names),
        );
        expect(asApp).toMatchObject({ code: "role_too_powerful", variable: "DATABASE_URL" });

        const asDispatcher = await failureOf(
          verifyDatabase(
            { app: appPool(), dispatcher: pool(role.url) },
            { app: APP_ROLE, dispatcher: role.name },
          ),
        );
        expect(asDispatcher).toMatchObject({
          code: "role_too_powerful",
          variable: "DISPATCHER_DATABASE_URL",
        });
      },
    );
  });

  describe("the schema", () => {
    it("refuses a database that has not been migrated", async () => {
      const empty = await emptyDatabase();
      const error = await failureOf(
        verifyDatabase({
          app: pool(rewrite(database.appUrl, { database: empty })),
          dispatcher: pool(rewrite(database.dispatcherUrl, { database: empty })),
        }),
      );
      expect(error).toMatchObject({ code: "schema_not_ready", variable: "DATABASE_URL" });
      expect(error.message).toContain("db_42P01");
    });

    it("refuses a database that is missing a column the handlers use", async () => {
      const old = await emptyDatabase();
      const setup = createPool({
        connectionString: rewrite(database.adminUrl, { database: old }),
        maxConnections: 1,
      });
      try {
        await setup.query("CREATE TABLE jobs (id int)");
        await setup.query("CREATE TABLE events (id int)"); // No batch_id: migration 0005 is missing.
        await setup.query(`GRANT SELECT ON jobs, events TO ${APP_ROLE}`);
      } finally {
        await setup.end();
      }
      const error = await failureOf(
        verifyDatabase({
          app: pool(rewrite(database.appUrl, { database: old })),
          dispatcher: dispatcherPool(),
        }),
      );
      expect(error).toMatchObject({ code: "schema_not_ready", variable: "DATABASE_URL" });
      expect(error.message).toContain("db_42703");
    });

    it("refuses an application role that may not read what the handlers write", async () => {
      await admin.query(`REVOKE SELECT ON event_aggregates FROM ${APP_ROLE}`);
      try {
        const error = await failureOf(
          verifyDatabase({ app: appPool(), dispatcher: dispatcherPool() }),
        );
        expect(error).toMatchObject({ code: "schema_not_ready", variable: "DATABASE_URL" });
        expect(error.message).toContain("db_42501");
      } finally {
        await admin.query(`GRANT SELECT ON event_aggregates TO ${APP_ROLE}`);
      }
      await expect(
        verifyDatabase({ app: appPool(), dispatcher: dispatcherPool() }),
      ).resolves.toBeUndefined();
    });

    it("refuses a dispatcher role that may not read the jobs", async () => {
      await admin.query(`REVOKE SELECT ON jobs FROM ${DISPATCHER_ROLE}`);
      try {
        const error = await failureOf(
          verifyDatabase({ app: appPool(), dispatcher: dispatcherPool() }),
        );
        expect(error).toMatchObject({
          code: "schema_not_ready",
          variable: "DISPATCHER_DATABASE_URL",
        });
      } finally {
        await admin.query(`GRANT SELECT ON jobs TO ${DISPATCHER_ROLE}`);
      }
    });

    it.each(["a throwaway role", "pg_read_all_data"])(
      "refuses a runtime role that is a member of another role (%s)",
      async (kind) => {
        const role = await throwawayRole("");
        let granted = "pg_read_all_data";
        if (kind === "a throwaway role") {
          granted = `cm_pf_${randomBytes(6).toString("hex")}`;
          await admin.query(`CREATE ROLE ${granted} NOLOGIN`);
          roles.push(granted);
        }
        await admin.query(`GRANT ${granted} TO ${role.name}`);

        const asApp = await failureOf(
          verifyDatabase(
            { app: pool(role.url), dispatcher: dispatcherPool() },
            { app: role.name, dispatcher: DISPATCHER_ROLE },
          ),
        );
        expect(asApp).toMatchObject({ code: "role_too_powerful", variable: "DATABASE_URL" });
        expect(asApp.message).toContain("member of other roles");

        const asDispatcher = await failureOf(
          verifyDatabase(
            { app: appPool(), dispatcher: pool(role.url) },
            { app: APP_ROLE, dispatcher: role.name },
          ),
        );
        expect(asDispatcher).toMatchObject({
          code: "role_too_powerful",
          variable: "DISPATCHER_DATABASE_URL",
        });
      },
    );

    it("refuses a role of the right name that has been given nothing", async () => {
      const role = await throwawayRole("");
      const error = await failureOf(
        verifyDatabase(
          { app: pool(role.url), dispatcher: dispatcherPool() },
          { app: role.name, dispatcher: DISPATCHER_ROLE },
        ),
      );
      expect(error).toMatchObject({ code: "schema_not_ready", variable: "DATABASE_URL" });
    });
  });

  describe("the connection", () => {
    async function closedPort(): Promise<string> {
      const server = createServer();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      server.close();
      await once(server, "close");
      if (address === null || typeof address === "string") throw new Error("no port");
      return String(address.port);
    }

    it("says which connection could not be made, with the network error's code", async () => {
      const unreachable = rewrite(database.appUrl, { host: "127.0.0.1", port: await closedPort() });
      const asApp = await failureOf(
        verifyDatabase({ app: pool(unreachable), dispatcher: dispatcherPool() }),
      );
      expect(asApp).toMatchObject({ code: "database_unreachable", variable: "DATABASE_URL" });
      expect(asApp.message).toContain("ECONNREFUSED");

      const asDispatcher = await failureOf(
        verifyDatabase({ app: appPool(), dispatcher: pool(unreachable) }),
      );
      expect(asDispatcher).toMatchObject({
        code: "database_unreachable",
        variable: "DISPATCHER_DATABASE_URL",
      });
    });

    it("never repeats a connection string, a host, a user or a password", async () => {
      const unreachable = rewrite(database.appUrl, { host: "127.0.0.1", port: await closedPort() });
      const failures = [
        await failureOf(verifyDatabase({ app: pool(unreachable), dispatcher: dispatcherPool() })),
        await failureOf(verifyDatabase({ app: appPool(), dispatcher: appPool() })),
        await failureOf(verifyDatabase({ app: dispatcherPool(), dispatcher: dispatcherPool() })),
      ];
      for (const error of failures) {
        expect(error.message).not.toContain(password);
        expect(error.message).not.toContain("postgres://");
        expect(error.message).not.toContain("127.0.0.1");
        expect(error.message).not.toContain(new URL(database.appUrl).hostname);
      }
    });
  });
});
