import {
  createOrganisation,
  createProject,
  issueApiKey,
  revokeApiKey,
  type ApiKeyScope,
} from "@codemugs/auth";
import { loadApiConfig, Secret } from "@codemugs/configuration";
import { createPool, type Pool } from "@codemugs/storage";
import { adminDatabaseUrl, createTestDatabase, type TestDatabase } from "@codemugs/storage/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { appServices, createDatabaseServices, type DatabaseServices } from "./database.js";

const describeDatabase = adminDatabaseUrl() === undefined ? describe.skip : describe;

const SYSTEM = { type: "system" } as const;
const NO_SUCH_ID = "00000000-0000-4000-8000-000000000000";

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

/** A project, and keys of it that may do different things. */
interface Project {
  readonly organisationId: string;
  readonly projectId: string;
  readonly both: string;
  readonly writer: string;
  readonly reader: string;
  /** Made without scopes, so it may send events and nothing else. */
  readonly events: string;
}

describeDatabase("the analysis routes against PostgreSQL", () => {
  const cleanup: Array<() => Promise<void>> = [];
  let database: TestDatabase;
  let seed: Pool;
  let admin: Pool;
  let built: BuiltApp;
  let services: DatabaseServices;

  let orgA: string;
  let orgB: string;
  const INSTALLATION_A = 1001;
  const INSTALLATION_B = 2002;

  /** A request with the given key. */
  const call = (key: string, method: "GET" | "POST", url: string, payload?: unknown) =>
    built.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });

  const count = async (table: string, organisationId: string): Promise<number> =>
    Number(
      (
        await admin.query<{ n: string }>(
          `SELECT count(*) AS n FROM ${table} WHERE organisation_id = $1`,
          [organisationId],
        )
      ).rows[0]?.n,
    );

  let counter = 0;
  /** A project of its own, so that no test depends on another. */
  async function newProject(organisationId: string): Promise<Project> {
    counter += 1;
    const projectId = (
      await createProject(seed, organisationId, { name: `project-${counter}`, actor: SYSTEM })
    ).id;
    const key = async (name: string, scopes?: ApiKeyScope[]): Promise<string> =>
      (
        await issueApiKey(seed, organisationId, projectId, {
          name,
          actor: SYSTEM,
          ...(scopes === undefined ? {} : { scopes }),
        })
      ).key;
    return {
      organisationId,
      projectId,
      both: await key("both", ["analysis:write", "analysis:read"]),
      writer: await key("writer", ["analysis:write"]),
      reader: await key("reader", ["analysis:read"]),
      events: await key("events"),
    };
  }

  /** A project that is a repository already. */
  async function connectedProject(
    organisationId: string,
    installationId: number,
  ): Promise<Project> {
    const project = await newProject(organisationId);
    const response = await call(project.both, "POST", "/v1/repository", {
      installationId,
      owner: "acme",
      name: "shop",
    });
    expect(response.statusCode).toBe(201);
    return project;
  }

  /** A connected project with an analysis asked for. */
  async function queuedAnalysis(
    organisationId: string,
    installationId: number,
  ): Promise<{ project: Project; id: string }> {
    const project = await connectedProject(organisationId, installationId);
    const response = await call(project.both, "POST", "/v1/analyses", { ref: "main" });
    expect(response.statusCode).toBe(202);
    return { project, id: response.json<{ id: string }>().id };
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
    // What an operator does: binds an installation of the GitHub App to an organisation.
    for (const [organisationId, installationId] of [
      [orgA, INSTALLATION_A],
      [orgB, INSTALLATION_B],
    ] as const) {
      await admin.query(
        "INSERT INTO github_installations (organisation_id, installation_id) VALUES ($1, $2)",
        [organisationId, installationId],
      );
    }

    // The real wiring: the same code main.ts uses, pointed at the test database.
    services = createDatabaseServices(new Secret(database.appUrl), {
      onError: () => undefined,
    });
    built = await buildApp({
      config: loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      ...appServices(services),
    });
    cleanup.unshift(async () => {
      await built.app.close();
      await services.close().catch(() => undefined);
    });
  }, 60_000);

  afterAll(async () => {
    for (const close of cleanup) await close();
  });

  describe("connecting a repository", () => {
    it("says that the project is a repository, and says it back", async () => {
      const project = await newProject(orgA);
      expect((await call(project.reader, "GET", "/v1/repository")).statusCode).toBe(404);

      const connected = await call(project.both, "POST", "/v1/repository", {
        installationId: INSTALLATION_A,
        owner: "acme",
        name: "shop",
      });
      expect(connected.statusCode).toBe(201);
      expect(connected.json()).toMatchObject({
        projectId: project.projectId,
        installationId: INSTALLATION_A,
        owner: "acme",
        name: "shop",
      });

      const after = await call(project.reader, "GET", "/v1/repository");
      expect(after.statusCode).toBe(200);
      expect(after.json()).toEqual(connected.json());
    });

    it("says it once: a second connection is refused and the first stands", async () => {
      const project = await connectedProject(orgA, INSTALLATION_A);
      const before = await count("repository_connections", orgA);

      const again = await call(project.both, "POST", "/v1/repository", {
        installationId: INSTALLATION_A,
        owner: "acme",
        name: "other",
      });

      expect(again.statusCode).toBe(409);
      expect(again.json<ErrorBody>().error.code).toBe("connection_exists");
      expect(await count("repository_connections", orgA)).toBe(before);
      expect((await call(project.reader, "GET", "/v1/repository")).json()).toMatchObject({
        name: "shop",
      });
    });

    it("refuses an installation that is not the organisation's, the same whether it is another's or nobody's", async () => {
      const project = await newProject(orgA);
      const before = await count("repository_connections", orgA);
      const connect = (installationId: number) =>
        call(project.both, "POST", "/v1/repository", {
          installationId,
          owner: "acme",
          name: "shop",
        });

      const others = await connect(INSTALLATION_B);
      const nobody = await connect(987654);

      expect(others.statusCode).toBe(404);
      expect(nobody.statusCode).toBe(404);
      const shape = (r: typeof others) => {
        const { error } = r.json<ErrorBody>();
        return { code: error.code, message: error.message };
      };
      expect(shape(others)).toEqual(shape(nobody));
      expect(shape(others).code).toBe("installation_not_found");
      expect(await count("repository_connections", orgA)).toBe(before);
    });

    it("refuses a project that the body names, and writes nothing", async () => {
      const mine = await newProject(orgA);
      const other = await newProject(orgA);
      const before = await count("repository_connections", orgA);

      const response = await call(mine.both, "POST", "/v1/repository", {
        installationId: INSTALLATION_A,
        owner: "acme",
        name: "shop",
        projectId: other.projectId,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe("invalid_input");
      expect(await count("repository_connections", orgA)).toBe(before);
      expect((await call(other.reader, "GET", "/v1/repository")).statusCode).toBe(404);
      expect((await call(mine.reader, "GET", "/v1/repository")).statusCode).toBe(404);
    });

    it("connects the project of the credential even when the input of the service names another", async () => {
      // The route refuses such a body (above). This is the service on its own, which must not
      // depend on that: the project is the credential's whatever it is given.
      const mine = await newProject(orgA);
      const other = await newProject(orgA);
      const hostile = {
        installationId: INSTALLATION_A,
        owner: "acme",
        name: "shop",
        projectId: other.projectId,
      };

      await services.analysis.connect(
        { organisationId: orgA, projectId: mine.projectId, apiKeyId: mine.projectId, scopes: [] },
        hostile,
      );

      expect((await call(mine.reader, "GET", "/v1/repository")).statusCode).toBe(200);
      expect((await call(other.reader, "GET", "/v1/repository")).statusCode).toBe(404);
    });

    it("refuses what GitHub would not allow, before anything is written", async () => {
      const project = await newProject(orgA);
      const before = await count("repository_connections", orgA);
      for (const body of [
        { installationId: INSTALLATION_A, owner: "../etc", name: "shop" },
        { installationId: INSTALLATION_A, owner: "acme", name: ".." },
        { installationId: 0, owner: "acme", name: "shop" },
        { installationId: 1.5, owner: "acme", name: "shop" },
      ]) {
        const response = await call(project.both, "POST", "/v1/repository", body);
        expect(response.statusCode, JSON.stringify(body)).toBe(400);
      }
      expect(await count("repository_connections", orgA)).toBe(before);
    });
  });

  describe("asking for an analysis, and reading how it is going", () => {
    it("refuses a project that is not connected, and writes nothing", async () => {
      const project = await newProject(orgA);
      const requests = await count("analysis_requests", orgA);
      const jobs = await count("jobs", orgA);

      const response = await call(project.both, "POST", "/v1/analyses", { ref: "main" });

      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorBody>().error.code).toBe("connection_not_found");
      expect(await count("analysis_requests", orgA)).toBe(requests);
      expect(await count("jobs", orgA)).toBe(jobs);
    });

    it("records the request and queues the job together, and says where to look", async () => {
      const project = await connectedProject(orgA, INSTALLATION_A);

      const response = await call(project.both, "POST", "/v1/analyses", { ref: "release/1.2" });

      expect(response.statusCode).toBe(202);
      const { id, status } = response.json<{ id: string; status: string }>();
      expect(status).toBe("queued");
      expect(response.headers.location).toBe(`/v1/analyses/${id}`);
      const jobs = await admin.query<{ kind: string; status: string }>(
        "SELECT kind, status FROM jobs WHERE organisation_id = $1 AND subject_id = $2",
        [orgA, id],
      );
      expect(jobs.rows).toEqual([{ kind: "repository.analyse", status: "queued" }]);
      const requests = await admin.query<{ ref: string }>(
        "SELECT ref FROM analysis_requests WHERE organisation_id = $1 AND id = $2",
        [orgA, id],
      );
      expect(requests.rows).toEqual([{ ref: "release/1.2" }]);
    });

    it("refuses a ref that the library refuses, and writes nothing", async () => {
      const project = await connectedProject(orgA, INSTALLATION_A);
      const before = await count("analysis_requests", orgA);
      for (const ref of ["has space", "x".repeat(256), "", "new\nline"]) {
        const response = await call(project.both, "POST", "/v1/analyses", { ref });
        expect(response.statusCode, JSON.stringify(ref)).toBe(400);
      }
      expect(await count("analysis_requests", orgA)).toBe(before);
    });

    it("says that it is queued, and lists it", async () => {
      const { project, id } = await queuedAnalysis(orgA, INSTALLATION_A);

      const one = await call(project.reader, "GET", `/v1/analyses/${id}`);
      expect(one.statusCode).toBe(200);
      expect(one.json()).toMatchObject({
        id,
        projectId: project.projectId,
        ref: "main",
        status: "queued",
        attempts: 0,
      });
      expect(one.json()).not.toHaveProperty("failureCode");
      expect(one.json()).not.toHaveProperty("run");

      const list = await call(project.reader, "GET", "/v1/analyses?limit=5");
      expect(list.statusCode).toBe(200);
      expect(list.json<{ analyses: Array<{ id: string }> }>().analyses.map((a) => a.id)).toEqual([
        id,
      ]);
    });

    it("gives the code of a failure and no more, once the job has given up", async () => {
      const { project, id } = await queuedAnalysis(orgA, INSTALLATION_A);
      // What a worker does when it gives up on a job.
      await admin.query(
        `UPDATE jobs SET status = 'dead', attempts = 3, last_error_code = 'repository_too_large',
                         finished_at = now()
          WHERE organisation_id = $1 AND subject_id = $2`,
        [orgA, id],
      );

      const response = await call(project.reader, "GET", `/v1/analyses/${id}`);

      expect(response.json()).toMatchObject({
        status: "failed",
        attempts: 3,
        failureCode: "repository_too_large",
      });
    });

    it("is not found by another organisation, nor by another project of the same one, and is the same answer as for an id that is nowhere", async () => {
      const { id } = await queuedAnalysis(orgA, INSTALLATION_A);
      const sameOrganisation = await newProject(orgA);
      const otherOrganisation = await newProject(orgB);
      const nowhere = await call(sameOrganisation.both, "GET", `/v1/analyses/${NO_SUCH_ID}`);
      expect(nowhere.statusCode).toBe(404);

      for (const project of [sameOrganisation, otherOrganisation]) {
        const response = await call(project.both, "GET", `/v1/analyses/${id}`);
        expect(response.statusCode).toBe(404);
        expect(response.json<ErrorBody>().error.code).toBe("analysis_not_found");
        expect(response.json<ErrorBody>().error.message).toBe(
          nowhere.json<ErrorBody>().error.message,
        );
        const list = await call(project.both, "GET", "/v1/analyses");
        expect(list.json<{ analyses: unknown[] }>().analyses).toEqual([]);
      }
    });

    it("lists only the analyses of the key's own project", async () => {
      const first = await queuedAnalysis(orgA, INSTALLATION_A);
      const second = await queuedAnalysis(orgA, INSTALLATION_A);
      const theirs = await queuedAnalysis(orgB, INSTALLATION_B);

      const ids = async (project: Project) =>
        (await call(project.reader, "GET", "/v1/analyses"))
          .json<{ analyses: Array<{ id: string }> }>()
          .analyses.map((a) => a.id);

      expect(await ids(first.project)).toEqual([first.id]);
      expect(await ids(second.project)).toEqual([second.id]);
      expect(await ids(theirs.project)).toEqual([theirs.id]);
    });

    it("refuses a page size beyond what the library allows", async () => {
      const project = await newProject(orgA);
      const response = await call(project.reader, "GET", "/v1/analyses?limit=101");
      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe("invalid_input");
    });
  });

  describe("scopes", () => {
    it("a key that only reads cannot connect or ask, and nothing is written", async () => {
      const project = await connectedProject(orgA, INSTALLATION_A);
      const requests = await count("analysis_requests", orgA);
      const connections = await count("repository_connections", orgA);
      const other = await newProject(orgA);

      const responses = await Promise.all([
        call(other.reader, "POST", "/v1/repository", {
          installationId: INSTALLATION_A,
          owner: "acme",
          name: "shop",
        }),
        call(project.reader, "POST", "/v1/analyses", { ref: "main" }),
      ]);

      for (const response of responses) expect(response.statusCode).toBe(403);
      expect(await count("analysis_requests", orgA)).toBe(requests);
      expect(await count("repository_connections", orgA)).toBe(connections);
    });

    it("a key that only writes cannot read, and a key that sends events can do none of it", async () => {
      const { project, id } = await queuedAnalysis(orgA, INSTALLATION_A);
      for (const key of [project.writer, project.events]) {
        for (const url of ["/v1/repository", "/v1/analyses", `/v1/analyses/${id}`]) {
          expect((await call(key, "GET", url)).statusCode, url).toBe(403);
        }
      }
      for (const url of ["/v1/repository", "/v1/analyses"]) {
        const response = await call(project.events, "POST", url, {});
        expect(response.statusCode, url).toBe(403);
      }
    });

    it("a revoked key is refused as a key", async () => {
      const project = await connectedProject(orgA, INSTALLATION_A);
      const key = await issueApiKey(seed, orgA, project.projectId, {
        name: "short-lived",
        actor: SYSTEM,
        scopes: ["analysis:read"],
      });
      expect((await call(key.key, "GET", "/v1/repository")).statusCode).toBe(200);
      await revokeApiKey(seed, orgA, key.id, { actor: SYSTEM });
      expect((await call(key.key, "GET", "/v1/repository")).statusCode).toBe(401);
    });
  });
});
