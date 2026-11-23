import { randomUUID } from "node:crypto";
import { createOrganisation, createProject, issueApiKey, type ApiKeyScope } from "@codemugs/auth";
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

interface SeedNode {
  id: number;
  kind: string;
  key: string;
}

/** Files a, b and c import each other in a ring, a imports the module express, and all are in a package. */
const RING: readonly SeedNode[] = [
  { id: 0, kind: "file", key: "src/a.ts" },
  { id: 1, kind: "file", key: "src/b.ts" },
  { id: 2, kind: "file", key: "src/c.ts" },
  { id: 3, kind: "module", key: "express" },
  { id: 4, kind: "package", key: "." },
];
const RING_EDGES = [
  [0, 1, "imports"],
  [1, 2, "imports"],
  [2, 0, "imports"],
  [0, 3, "imports"],
  [0, 4, "in_package"],
  [1, 4, "in_package"],
  [2, 4, "in_package"],
] as const;

/** What the routes are asked for, for a run, as [url, whether the body may say what another tenant has]. */
const readsOf = (run: string): string[] => [
  `/v1/analyses/${run}/graph`,
  `/v1/analyses/${run}/nodes`,
  `/v1/analyses/${run}/node?kind=file&key=src/a.ts`,
  `/v1/analyses/${run}/nodes/0/neighbours`,
  `/v1/analyses/${run}/imports?path=src/a.ts&direction=importers`,
];

describeDatabase("the routes that read a graph, against PostgreSQL", () => {
  const cleanup: Array<() => Promise<void>> = [];
  let database: TestDatabase;
  let seed: Pool;
  let admin: Pool;
  let built: BuiltApp;
  let services: DatabaseServices;

  interface Project {
    readonly organisationId: string;
    readonly projectId: string;
    readonly reader: string;
    readonly writer: string;
    readonly events: string;
  }

  let counter = 0;
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
      reader: await key("reader", ["analysis:read"]),
      writer: await key("writer", ["analysis:write"]),
      events: await key("events"),
    };
  }

  /** Writes a run by hand, with the superuser: what the worker stores, without the worker. */
  async function seedRun(
    project: Project,
    nodes: readonly SeedNode[],
    edges: ReadonlyArray<readonly [number, number, string]>,
  ): Promise<string> {
    const runId = randomUUID();
    await admin.query(
      `INSERT INTO analysis_runs (organisation_id, id, project_id, revision, facts_version, summary,
                                  node_count, edge_count, digest)
       VALUES ($1, $2, $3, $4, 1, '{"files": 3}', $5, $6, $7)`,
      [
        project.organisationId,
        runId,
        project.projectId,
        "0123456789abcdef0123456789abcdef01234567",
        nodes.length,
        edges.length,
        "b".repeat(64),
      ],
    );
    for (const node of nodes) {
      await admin.query(
        `INSERT INTO graph_nodes (organisation_id, run_id, id, kind, key, attributes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          project.organisationId,
          runId,
          node.id,
          node.kind,
          node.key,
          JSON.stringify({ origin: node.key }),
        ],
      );
    }
    for (const [from, to, kind] of edges) {
      await admin.query(
        `INSERT INTO graph_edges (organisation_id, run_id, from_id, to_id, kind)
         VALUES ($1, $2, $3, $4, $5)`,
        [project.organisationId, runId, from, to, kind],
      );
    }
    return runId;
  }

  const get = (key: string, url: string) =>
    built.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}` } });

  let orgA: string;
  let orgB: string;
  let one: Project;
  let two: Project;
  let never: Project;
  let other: Project;
  let older: string;
  let latest: string;
  let twoRun: string;
  let otherRun: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    cleanup.unshift(() => database.drop());
    seed = createPool({ connectionString: database.appUrl, maxConnections: 2 });
    cleanup.unshift(() => seed.end());
    admin = createPool({ connectionString: database.adminUrl, maxConnections: 2 });
    cleanup.unshift(() => admin.end());

    orgA = (await createOrganisation(seed, { name: "Organisation A" })).id;
    orgB = (await createOrganisation(seed, { name: "Organisation B" })).id;
    one = await newProject(orgA);
    two = await newProject(orgA);
    never = await newProject(orgA);
    other = await newProject(orgB);

    older = await seedRun(
      one,
      [RING[0] as SeedNode, RING[3] as SeedNode].map((n, id) => ({ ...n, id })),
      [[0, 1, "imports"]],
    );
    latest = await seedRun(one, RING, RING_EDGES);
    // Other projects have graphs of their own, with names that must never reach this project's key.
    twoRun = await seedRun(two, [{ id: 0, kind: "file", key: "src/other-project-only.ts" }], []);
    otherRun = await seedRun(
      other,
      [{ id: 0, kind: "file", key: "src/other-organisation-only.ts" }],
      [],
    );

    services = createDatabaseServices(new Secret(database.appUrl), { onError: () => undefined });
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

  describe("the graph of a project", () => {
    it("is the run that was stored last, and a run can be asked for by its id", async () => {
      const now = await get(one.reader, "/v1/graph");
      expect(now.statusCode).toBe(200);
      expect(now.json()).toMatchObject({
        run: {
          id: latest,
          projectId: one.projectId,
          revision: "0123456789abcdef0123456789abcdef01234567",
          nodes: 5,
          edges: 7,
          truncated: [],
          summary: { files: 3 },
          digest: "b".repeat(64),
        },
      });
      const before = await get(one.reader, `/v1/analyses/${older}/graph`);
      expect(before.json()).toMatchObject({ run: { id: older, nodes: 2, edges: 1 } });
    });

    it("is not there for a project that was never analysed", async () => {
      const response = await get(never.reader, "/v1/graph");
      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorBody>().error.code).toBe("graph_not_found");
    });
  });

  describe("nodes", () => {
    it("come a page at a time in the order of their ids, and by kind", async () => {
      const first = await get(one.reader, `/v1/analyses/${latest}/nodes?limit=2`);
      expect(first.json<{ nodes: Array<{ key: string }>; next?: number }>()).toMatchObject({
        nodes: [{ key: "src/a.ts" }, { key: "src/b.ts" }],
        next: 1,
      });
      const second = await get(one.reader, `/v1/analyses/${latest}/nodes?limit=2&after=1`);
      expect(second.json<{ nodes: Array<{ key: string }>; next?: number }>()).toMatchObject({
        nodes: [{ key: "src/c.ts" }, { key: "express" }],
        next: 3,
      });
      const last = await get(one.reader, `/v1/analyses/${latest}/nodes?limit=2&after=3`);
      expect(last.json()).toEqual({
        nodes: [{ id: 4, kind: "package", key: ".", attributes: { origin: "." } }],
      });
      const modules = await get(one.reader, `/v1/analyses/${latest}/nodes?kind=module`);
      expect(modules.json<{ nodes: Array<{ key: string }> }>().nodes.map((n) => n.key)).toEqual([
        "express",
      ]);
    });

    it("can be found by what they are and their key", async () => {
      const found = await get(
        one.reader,
        `/v1/analyses/${latest}/node?kind=file&key=${encodeURIComponent("src/b.ts")}`,
      );
      expect(found.json()).toEqual({
        node: { id: 1, kind: "file", key: "src/b.ts", attributes: { origin: "src/b.ts" } },
      });
      for (const url of [
        `/v1/analyses/${latest}/node?kind=file&key=express`,
        `/v1/analyses/${latest}/node?kind=file&key=src/missing.ts`,
      ]) {
        const missing = await get(one.reader, url);
        expect(missing.statusCode).toBe(404);
        expect(missing.json<ErrorBody>().error.code).toBe("node_not_found");
      }
    });
  });

  describe("edges", () => {
    it("lead from a node and to it, by kind, and a node with none is not a node that is missing", async () => {
      const out = await get(one.reader, `/v1/analyses/${latest}/nodes/0/neighbours`);
      expect(
        out
          .json<{ neighbours: Array<{ edge: { kind: string }; node: { key: string } }> }>()
          .neighbours.map((n) => `${n.edge.kind}:${n.node.key}`),
      ).toEqual(["imports:src/b.ts", "imports:express", "in_package:."]);

      const imports = await get(
        one.reader,
        `/v1/analyses/${latest}/nodes/0/neighbours?edge=imports`,
      );
      expect(imports.json<{ neighbours: unknown[] }>().neighbours).toHaveLength(2);

      const into = await get(
        one.reader,
        `/v1/analyses/${latest}/nodes/0/neighbours?direction=in&edge=imports`,
      );
      expect(
        into
          .json<{ neighbours: Array<{ node: { key: string } }> }>()
          .neighbours.map((n) => n.node.key),
      ).toEqual(["src/c.ts"]);

      // Express is a node with no edge leaving it: a 200 and an empty list.
      const leaf = await get(one.reader, `/v1/analyses/${latest}/nodes/3/neighbours`);
      expect(leaf.statusCode).toBe(200);
      expect(leaf.json()).toEqual({ neighbours: [] });

      // A node that is not there is not found, and is not told from a leaf by an empty list.
      const missing = await get(one.reader, `/v1/analyses/${latest}/nodes/99/neighbours`);
      expect(missing.statusCode).toBe(404);
      expect(missing.json<ErrorBody>().error.code).toBe("node_not_found");
    });
  });

  describe("imports", () => {
    it("reach the files that a change reaches, nearest first, and end in a ring", async () => {
      const reached = await get(
        one.reader,
        `/v1/analyses/${latest}/imports?path=src/a.ts&direction=importers`,
      );
      expect(
        reached
          .json<{ files: Array<{ key: string; depth: number }> }>()
          .files.map((f) => `${f.key}:${String(f.depth)}`),
      ).toEqual(["src/c.ts:1", "src/b.ts:2"]);

      const shallow = await get(
        one.reader,
        `/v1/analyses/${latest}/imports?path=src/a.ts&direction=imports&depth=1`,
      );
      expect(shallow.json<{ files: Array<{ key: string }> }>().files.map((f) => f.key)).toEqual([
        "src/b.ts",
      ]);
    });

    it("are not asked of a path that is not a file of the run", async () => {
      for (const path of ["express", "src/missing.ts"]) {
        const response = await get(
          one.reader,
          `/v1/analyses/${latest}/imports?path=${encodeURIComponent(path)}&direction=imports`,
        );
        expect(response.statusCode).toBe(404);
        expect(response.json<ErrorBody>().error.code).toBe("node_not_found");
      }
    });
  });

  describe("another tenant's graph", () => {
    it("is not there: another project of the organisation, and another organisation, are the same 404 as a run that does not exist", async () => {
      const absent = async (key: string, run: string) =>
        Promise.all(readsOf(run).map(async (url) => (await get(key, url)).json<ErrorBody>()));

      const nothing = await absent(one.reader, NO_SUCH_ID);
      for (const body of nothing) expect(body.error.code).toBe("graph_not_found");

      // The same answer, word for word, whoever's graph it is.
      for (const [key, run] of [
        [one.reader, twoRun],
        [one.reader, otherRun],
        [two.reader, latest],
        [other.reader, latest],
        [other.reader, twoRun],
      ] as const) {
        const bodies = await absent(key, run);
        expect(bodies.map((b) => b.error.code)).toEqual(nothing.map(() => "graph_not_found"));
        expect(bodies.map((b) => b.error.message)).toEqual(nothing.map((b) => b.error.message));
      }
    });

    it("is never in what a key is given: the latest graph is its own project's", async () => {
      const mine = await get(two.reader, "/v1/graph");
      expect(mine.json()).toMatchObject({ run: { id: twoRun, projectId: two.projectId } });
      const theirs = await get(other.reader, "/v1/graph");
      expect(theirs.json()).toMatchObject({ run: { id: otherRun, projectId: other.projectId } });

      const pages = await Promise.all([
        ...readsOf(latest).map((url) => get(one.reader, url)),
        get(one.reader, "/v1/graph"),
        get(one.reader, `/v1/analyses/${older}/nodes`),
      ]);
      for (const response of pages) {
        expect(response.body).not.toContain("other-project-only");
        expect(response.body).not.toContain("other-organisation-only");
        expect(response.body).not.toContain(twoRun);
        expect(response.body).not.toContain(otherRun);
      }
    });

    it("cannot be named by the request: a project or an organisation in the query is refused", async () => {
      for (const parameter of [`projectId=${two.projectId}`, `organisationId=${orgB}`]) {
        const response = await get(one.reader, `/v1/graph?${parameter}`);
        expect(response.statusCode).toBe(400);
      }
    });
  });

  describe("who may read", () => {
    it("is a key with analysis:read, and no other", async () => {
      for (const url of readsOf(latest)) {
        expect((await get(one.writer, url)).statusCode).toBe(403);
        expect((await get(one.events, url)).statusCode).toBe(403);
        expect((await built.app.inject({ method: "GET", url })).statusCode).toBe(401);
        expect((await get("cm_not_a_key", url)).statusCode).toBe(401);
        expect((await get(one.reader, url)).statusCode).toBe(200);
      }
    });

    it("refuses an id that is not one, and says nothing of what it was", async () => {
      const response = await get(one.reader, "/v1/analyses/not-a-uuid/nodes");
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("not-a-uuid");
      const none = await get(one.reader, `/v1/analyses/${NO_SUCH_ID}/nodes`);
      expect(none.statusCode).toBe(404);
    });
  });

  describe("reading", () => {
    it("writes nothing", async () => {
      const count = async (): Promise<string> =>
        JSON.stringify(
          (
            await admin.query(
              `SELECT (SELECT count(*) FROM analysis_runs) AS runs,
                      (SELECT count(*) FROM graph_nodes) AS nodes,
                      (SELECT count(*) FROM graph_edges) AS edges,
                      (SELECT count(*) FROM audit_log) AS audit,
                      (SELECT count(*) FROM jobs) AS jobs`,
            )
          ).rows,
        );
      const before = await count();
      for (const url of readsOf(latest)) await get(one.reader, url);
      await get(one.reader, "/v1/graph");
      expect(await count()).toBe(before);
    });
  });
});
