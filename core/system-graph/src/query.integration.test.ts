import { randomUUID } from "node:crypto";
import { withTenant, type TenantClient } from "@codemugs/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGraph } from "./build.js";
import { describeDatabase, graphErrorCode, startHarness } from "./db-harness.js";
import type { Harness, Tenant } from "./db-harness.js";
import {
  findNode,
  getRun,
  importClosure,
  latestRun,
  listNodes,
  MAX_DEPTH,
  MAX_LIMIT,
  neighbours,
} from "./query.js";
import { saveAnalysis } from "./store.js";
import { importOf, makeFacts, shopFacts } from "./test-harness.js";

const REVISION = "fedcba9876543210fedcba9876543210fedcba98";

/** Files that import each other: a cycle (a, b, c), a file that joins it (d) and one that is alone (e). */
function cycleFacts() {
  const internal = (path: string) => ({ type: "internal" as const, path });
  return makeFacts({
    files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
    imports: [
      importOf("src/a.ts", "./b.js", internal("src/b.ts")),
      importOf("src/b.ts", "./c.js", internal("src/c.ts")),
      importOf("src/c.ts", "./a.js", internal("src/a.ts")),
      importOf("src/d.ts", "./c.js", internal("src/c.ts")),
      importOf("src/d.ts", "./b.js", internal("src/b.ts")),
      importOf("src/a.ts", "express", { type: "package", name: "express" }),
    ],
  });
}

describeDatabase("reading the system graph from PostgreSQL", () => {
  let h: Harness;
  let a: Tenant;
  let b: Tenant;
  let shopRun: string;
  let cycleRun: string;
  let foreignRun: string;

  beforeAll(async () => {
    h = await startHarness();
    a = await h.tenant("A");
    b = await h.tenant("B");
    shopRun = randomUUID();
    cycleRun = randomUUID();
    foreignRun = randomUUID();
    await save(a, {
      runId: shopRun,
      projectId: a.projectId,
      revision: REVISION,
      facts: shopFacts(),
    });
    await save(a, { runId: cycleRun, projectId: a.projectId, facts: cycleFacts() });
    await save(b, { runId: foreignRun, projectId: b.projectId, facts: shopFacts() });
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  const save = (tenant: Tenant, input: Parameters<typeof saveAnalysis>[1]) =>
    withTenant(h.app, tenant.organisationId, (client) => saveAnalysis(client, input));
  const read = <T>(tenant: Tenant, work: (client: TenantClient) => Promise<T>) =>
    withTenant(h.app, tenant.organisationId, work);

  const files = (reached: { node: { key: string }; depth: number }[]) =>
    reached.map((entry) => `${entry.node.key}:${String(entry.depth)}`);

  describe("runs", () => {
    it("gives a run as it was stored", async () => {
      const expected = buildGraph(shopFacts());
      const run = await read(a, (client) => getRun(client, shopRun));
      expect(run).toMatchObject({
        id: shopRun,
        projectId: a.projectId,
        revision: REVISION,
        factsVersion: 1,
        truncated: [],
        summary: expected.summary,
        nodeCount: expected.nodes.length,
        edgeCount: expected.edges.length,
        digest: expected.digest,
      });
      expect(run?.analysedAt).toBeInstanceOf(Date);
    });

    it("says nothing of the order in which runs were stored, which counts every organisation's runs", async () => {
      const keys = [
        "analysedAt",
        "digest",
        "edgeCount",
        "factsVersion",
        "id",
        "nodeCount",
        "projectId",
        "revision",
        "summary",
        "truncated",
      ];
      const byId = await read(a, (client) => getRun(client, shopRun));
      const latest = await read(a, (client) => latestRun(client, a.projectId));
      expect(Object.keys(byId ?? {}).sort()).toEqual(keys);
      expect(Object.keys(latest ?? {}).sort()).toEqual(keys);
    });

    it("gives nothing for a run that does not exist", async () => {
      expect(await read(a, (client) => getRun(client, randomUUID()))).toBeNull();
    });

    it("gives the newest run of a project, and nothing for a project that was never analysed", async () => {
      const older = randomUUID();
      const newer = randomUUID();
      await save(a, {
        runId: older,
        projectId: a.otherProjectId,
        facts: makeFacts({ files: ["x.ts"] }),
      });
      await save(a, {
        runId: newer,
        projectId: a.otherProjectId,
        facts: makeFacts({ files: ["y.ts"] }),
      });
      expect((await read(a, (client) => latestRun(client, a.otherProjectId)))?.id).toBe(newer);
      expect(await read(b, (client) => latestRun(client, b.otherProjectId))).toBeNull();
      expect(await read(a, (client) => latestRun(client, randomUUID()))).toBeNull();
    });

    // Every run that one transaction stores has the same start time, so the time cannot say which
    // was stored last. A worker that stores two analyses of one project in one transaction, and
    // reads "the graph now", must get the second, whatever the two ids happen to be.
    describe("when two runs of one project are stored in one transaction", () => {
      // Ids that sort far apart, so that an order by id would give the other answer.
      const low = (n: number) => `00000000-0000-4000-8000-0000000000${String(n)}`;
      const high = (n: number) => `ffffffff-ffff-4fff-8fff-ffffffffff${String(n)}`;

      it.each([
        ["the lower id second", high(10), low(10)],
        ["the higher id second", low(11), high(11)],
      ])("gives the one that was stored last, with %s", async (_name, first, second) => {
        await withTenant(h.app, a.organisationId, async (client) => {
          await saveAnalysis(client, {
            runId: first,
            projectId: a.otherProjectId,
            facts: makeFacts({ files: ["x.ts"] }),
          });
          await saveAnalysis(client, {
            runId: second,
            projectId: a.otherProjectId,
            facts: makeFacts({ files: ["y.ts"] }),
          });
        });
        expect((await read(a, (client) => latestRun(client, a.otherProjectId)))?.id).toBe(second);
      });
    });
  });

  describe("nodes", () => {
    it("finds a node by what it is and its key", async () => {
      const node = await read(a, (client) => findNode(client, shopRun, "route", "POST /orders"));
      expect(node).toMatchObject({
        kind: "route",
        key: "POST /orders",
        attributes: { method: "POST", path: "/orders" },
      });
      expect(
        await read(a, (client) => findNode(client, shopRun, "route", "GET /nothing")),
      ).toBeNull();
      expect(
        await read(a, (client) => findNode(client, shopRun, "file", "POST /orders")),
      ).toBeNull();
    });

    it("takes a key that looks like SQL for what it is: a key that is not there", async () => {
      for (const key of ["' OR 1=1 --", "x'; DROP TABLE graph_nodes; --"]) {
        expect(await read(a, (client) => findNode(client, shopRun, "file", key))).toBeNull();
      }
      expect(await read(a, (client) => listNodes(client, shopRun, { limit: 1 }))).toHaveLength(1);
    });

    it("lists the nodes of a run in the order of their ids", async () => {
      const expected = buildGraph(shopFacts()).nodes;
      const listed = await read(a, (client) => listNodes(client, shopRun));
      expect(listed).toEqual(expected);
    });

    it("lists the nodes of one kind", async () => {
      const listed = await read(a, (client) => listNodes(client, shopRun, { kind: "route" }));
      expect(listed.map((node) => node.key)).toEqual([
        "GET /health",
        "GET /products",
        "POST /orders",
      ]);
    });

    it("lists a page at a time, and the pages are the whole list", async () => {
      const everything = await read(a, (client) => listNodes(client, shopRun));
      const pages: typeof everything = [];
      let after: number | undefined;
      for (;;) {
        const page = await read(a, (client) =>
          listNodes(client, shopRun, {
            limit: 4,
            ...(after === undefined ? {} : { afterId: after }),
          }),
        );
        if (page.length === 0) break;
        expect(page.length).toBeLessThanOrEqual(4);
        pages.push(...page);
        after = page[page.length - 1]?.id;
      }
      expect(pages).toEqual(everything);
    });
  });

  describe("neighbours", () => {
    const describeEdges = (
      found: { edge: { kind: string }; node: { kind: string; key: string } }[],
    ) => found.map((entry) => `${entry.edge.kind} ${entry.node.kind}:${entry.node.key}`);

    it("gives what a node points at, with the edge that leads there", async () => {
      const node = await read(a, (client) =>
        findNode(client, shopRun, "file", "apps/api/src/server.ts"),
      );
      if (node === null) throw new Error("fixture");
      const out = await read(a, (client) =>
        neighbours(client, shopRun, node.id, { direction: "out" }),
      );
      expect(describeEdges(out)).toEqual([
        "defines_route route:GET /health",
        "imports builtin:http",
        "imports file:apps/api/src/routes.ts",
        "imports module:express",
        "imports package:packages/db",
        "in_package package:apps/api",
        "reads_env env_var:DATABASE_URL",
        "reads_env env_var:PORT",
        "uses_framework framework:express",
      ]);
      const route = out.find((entry) => entry.node.key === "GET /health");
      expect(route?.edge.attributes).toEqual({ confidence: "heuristic", line: 5, style: "http" });
    });

    it("gives what points at a node", async () => {
      const node = await read(a, (client) => findNode(client, shopRun, "env_var", "DATABASE_URL"));
      if (node === null) throw new Error("fixture");
      const into = await read(a, (client) =>
        neighbours(client, shopRun, node.id, { direction: "in" }),
      );
      expect(describeEdges(into)).toEqual([
        "reads_env file:apps/api/src/server.ts",
        "reads_env file:packages/db/src/client.ts",
      ]);
    });

    it("can be limited to one kind of edge, and to a number of them", async () => {
      const node = await read(a, (client) =>
        findNode(client, shopRun, "file", "apps/api/src/server.ts"),
      );
      if (node === null) throw new Error("fixture");
      const imports = await read(a, (client) =>
        neighbours(client, shopRun, node.id, { direction: "out", kind: "imports" }),
      );
      expect(imports).toHaveLength(4);
      const one = await read(a, (client) =>
        neighbours(client, shopRun, node.id, { direction: "out", kind: "imports", limit: 1 }),
      );
      expect(one).toHaveLength(1);
    });

    it("gives nothing for a node that does not exist", async () => {
      expect(
        await read(a, (client) => neighbours(client, shopRun, 9_999, { direction: "out" })),
      ).toEqual([]);
    });
  });

  describe("what a file reaches through imports", () => {
    it("gives the files that it imports, and theirs, nearest first, each once, and not itself", async () => {
      // a imports b; b imports c; c imports a (a cycle); and a imports a package, which is not a file.
      const fromA = await read(a, (client) =>
        importClosure(client, cycleRun, "src/a.ts", { direction: "imports" }),
      );
      expect(files(fromA)).toEqual(["src/b.ts:1", "src/c.ts:2"]);
      // d reaches c and b in one step each, and a through c.
      const fromD = await read(a, (client) =>
        importClosure(client, cycleRun, "src/d.ts", { direction: "imports" }),
      );
      expect(files(fromD)).toEqual(["src/b.ts:1", "src/c.ts:1", "src/a.ts:2"]);
    });

    it("gives the files that import it, and those that import those: what a change can reach", async () => {
      const intoA = await read(a, (client) =>
        importClosure(client, cycleRun, "src/a.ts", { direction: "importers" }),
      );
      expect(files(intoA)).toEqual(["src/c.ts:1", "src/b.ts:2", "src/d.ts:2"]);
      const intoC = await read(a, (client) =>
        importClosure(client, cycleRun, "src/c.ts", { direction: "importers" }),
      );
      expect(files(intoC)).toEqual(["src/b.ts:1", "src/d.ts:1", "src/a.ts:2"]);
    });

    it("stops at the depth that it was given", async () => {
      const near = await read(a, (client) =>
        importClosure(client, cycleRun, "src/c.ts", { direction: "importers", maxDepth: 1 }),
      );
      expect(files(near)).toEqual(["src/b.ts:1", "src/d.ts:1"]);
    });

    it("stops at the number of files that it was given", async () => {
      const one = await read(a, (client) =>
        importClosure(client, cycleRun, "src/c.ts", { direction: "importers", limit: 1 }),
      );
      expect(files(one)).toEqual(["src/b.ts:1"]);
    });

    it("counts the files of the levels before when it stops at the number of files", async () => {
      // c is one step away and b and d are two: a limit of two is used up by c and the first of them.
      const two = await read(a, (client) =>
        importClosure(client, cycleRun, "src/a.ts", { direction: "importers", limit: 2 }),
      );
      expect(files(two)).toEqual(["src/c.ts:1", "src/b.ts:2"]);
    });

    it("gives nothing for a file with no imports, for a path that is not a file, and for a package", async () => {
      expect(
        await read(a, (client) =>
          importClosure(client, cycleRun, "src/e.ts", { direction: "imports" }),
        ),
      ).toEqual([]);
      expect(
        await read(a, (client) =>
          importClosure(client, cycleRun, "src/nothing.ts", { direction: "imports" }),
        ),
      ).toEqual([]);
      expect(
        await read(a, (client) =>
          importClosure(client, cycleRun, "express", { direction: "importers" }),
        ),
      ).toEqual([]);
    });

    it("follows the imports of a real shape: the test imports the server, which imports the routes, which import the database", async () => {
      const reached = await read(a, (client) =>
        importClosure(client, shopRun, "apps/api/src/server.test.ts", { direction: "imports" }),
      );
      expect(files(reached)).toEqual([
        "apps/api/src/server.ts:1",
        "apps/api/src/routes.ts:2",
        "packages/db/src/index.ts:3",
        "packages/db/src/client.ts:4",
      ]);
    });
  });

  describe("between organisations", () => {
    it("shows an organisation nothing of a run of another, whichever way it asks", async () => {
      const node = await read(a, (client) =>
        findNode(client, shopRun, "file", "apps/api/src/server.ts"),
      );
      if (node === null) throw new Error("fixture");
      await read(b, async (client) => {
        expect(await getRun(client, shopRun)).toBeNull();
        expect(await getRun(client, cycleRun)).toBeNull();
        expect(await latestRun(client, a.projectId)).toBeNull();
        expect(await findNode(client, shopRun, "file", "apps/api/src/server.ts")).toBeNull();
        expect(await listNodes(client, shopRun)).toEqual([]);
        expect(await neighbours(client, shopRun, node.id, { direction: "out" })).toEqual([]);
        expect(await neighbours(client, shopRun, node.id, { direction: "in" })).toEqual([]);
        expect(
          await importClosure(client, cycleRun, "src/c.ts", { direction: "importers" }),
        ).toEqual([]);
        return null;
      });
    });

    it("shows an organisation its own run when another has a run with the same graph", async () => {
      const own = await read(b, (client) => listNodes(client, foreignRun));
      expect(own).toEqual(buildGraph(shopFacts()).nodes);
      expect(await read(b, (client) => getRun(client, foreignRun))).toMatchObject({
        projectId: b.projectId,
      });
      // And A does not see it.
      expect(await read(a, (client) => getRun(client, foreignRun))).toBeNull();
      expect(await read(a, (client) => listNodes(client, foreignRun))).toEqual([]);
    });
  });

  describe("the largest that is allowed", () => {
    it("is what the interface says it is", () => {
      expect(MAX_LIMIT).toBe(10_000);
      expect(MAX_DEPTH).toBe(50);
    });

    it("is allowed, and so is the least", async () => {
      expect(
        await read(a, (client) => listNodes(client, cycleRun, { limit: 10_000 })),
      ).toHaveLength(6);
      expect(await read(a, (client) => listNodes(client, cycleRun, { limit: 1 }))).toHaveLength(1);
      const deep = await read(a, (client) =>
        importClosure(client, cycleRun, "src/a.ts", {
          direction: "imports",
          maxDepth: 50,
          limit: 10_000,
        }),
      );
      expect(files(deep)).toEqual(["src/b.ts:1", "src/c.ts:2"]);
      const shallow = await read(a, (client) =>
        importClosure(client, cycleRun, "src/a.ts", { direction: "imports", maxDepth: 1 }),
      );
      expect(files(shallow)).toEqual(["src/b.ts:1"]);
    });
  });

  describe("how much the walk looks up", () => {
    /** The number of statements that a read sends: what a walk costs, whatever the planner knows. */
    async function statements(work: (client: TenantClient) => Promise<unknown>): Promise<number> {
      let count = 0;
      await read(a, (client) =>
        work({
          organisationId: client.organisationId,
          query: (text, values) => {
            count += 1;
            return client.query(text, values);
          },
        }),
      );
      return count;
    }

    it("is one statement to find the file, and two for each level that has something new", async () => {
      // e imports nothing: the file, and one look for what it imports.
      expect(
        await statements((c) => importClosure(c, cycleRun, "src/e.ts", { direction: "imports" })),
      ).toBe(2);
      // a reaches b, then c, and then only a, which it has already seen: two levels and a look.
      expect(
        await statements((c) => importClosure(c, cycleRun, "src/a.ts", { direction: "imports" })),
      ).toBe(1 + 2 + 2 + 1);
    });

    it("stops when the number of files is reached, and does not walk on for the rest", async () => {
      // One level gives b and d, which is more than the one that was asked for.
      expect(
        await statements((c) =>
          importClosure(c, cycleRun, "src/c.ts", { direction: "importers", limit: 1 }),
        ),
      ).toBe(1 + 2);
    });

    describe("what one level brings back from the nodes", () => {
      /** The rows that the statements reading `graph_nodes` bring back, and the statements. */
      async function nodeRows(work: (client: TenantClient) => Promise<unknown>) {
        let rows = 0;
        await read(a, (client) =>
          work({
            organisationId: client.organisationId,
            query: ((text: string, values?: unknown[]) => {
              const result = client.query(text, values);
              // Registered before the caller's own, so the count is made when the caller has the rows.
              void result.then((done) => {
                if (text.includes("FROM graph_nodes")) rows += done.rows.length;
              });
              return result;
            }) as TenantClient["query"],
          }),
        );
        return rows;
      }

      // One file that 30 others import and that imports the same 30: whichever way it is walked, one
      // level has 30 files in it, and a limit of a few must not fetch them all.
      const internal = (path: string) => ({ type: "internal" as const, path });
      const names = Array.from({ length: 30 }, (_, i) => `src/m${String(i).padStart(2, "0")}.ts`);
      let hubRun: string;
      beforeAll(async () => {
        hubRun = randomUUID();
        await save(a, {
          runId: hubRun,
          projectId: a.otherProjectId,
          facts: makeFacts({
            files: ["src/hub.ts", ...names],
            imports: names.flatMap((name) => [
              importOf("src/hub.ts", name, internal(name)),
              importOf(name, "./hub.js", internal("src/hub.ts")),
            ]),
          }),
        });
      });

      it.each(["imports", "importers"] as const)(
        "is the files that are given and the one that was asked about, and no more, going %s",
        async (direction) => {
          const rows = await nodeRows(async (c) => {
            const reached = await importClosure(c, hubRun, "src/hub.ts", { direction, limit: 3 });
            expect(reached.map((entry) => entry.node.key)).toEqual(names.slice(0, 3));
          });
          expect(rows).toBe(1 + 3);
        },
      );

      it("is every file of the level when the limit is not reached", async () => {
        const rows = await nodeRows(async (c) => {
          const reached = await importClosure(c, hubRun, "src/hub.ts", {
            direction: "imports",
            limit: 100,
          });
          expect(reached.map((entry) => entry.node.key)).toEqual(names);
        });
        // The hub, its 30 files, and then the hub is all that they reach, and it was seen.
        expect(rows).toBe(1 + 30);
      });
    });

    it("does not look for a file that does not exist beyond the one statement", async () => {
      expect(
        await statements((c) =>
          importClosure(c, cycleRun, "src/nothing.ts", { direction: "imports" }),
        ),
      ).toBe(1);
    });
  });

  describe("only imports are followed to find what a file reaches", () => {
    it("ignores an edge of another kind, even one that joins two files", async () => {
      // The builder makes no such edge today, and the database does not know the vocabulary, so a
      // kind that is added later must not change what an import closure means until it says so.
      const runId = randomUUID();
      await save(a, { runId, projectId: a.otherProjectId, facts: cycleFacts() });
      const e = await read(a, (client) => findNode(client, runId, "file", "src/e.ts"));
      const target = await read(a, (client) => findNode(client, runId, "file", "src/a.ts"));
      if (e === null || target === null) throw new Error("fixture");
      await h.admin.query(
        `INSERT INTO graph_edges (organisation_id, run_id, from_id, to_id, kind) VALUES ($1, $2, $3, $4, 'covers')`,
        [a.organisationId, runId, e.id, target.id],
      );
      const importers = await read(a, (client) =>
        importClosure(client, runId, "src/a.ts", { direction: "importers" }),
      );
      expect(files(importers)).toEqual(["src/c.ts:1", "src/b.ts:2", "src/d.ts:2"]);
      const imports = await read(a, (client) =>
        importClosure(client, runId, "src/e.ts", { direction: "imports" }),
      );
      expect(imports).toEqual([]);
    });

    it("does not go on from something that is not a file, even if an import leaves it", async () => {
      // Only a file imports, so the builder makes no such edge. If one were there, a package would
      // not become a place that a path goes on from.
      const runId = randomUUID();
      await save(a, {
        runId,
        projectId: a.otherProjectId,
        facts: makeFacts({
          files: ["src/x.ts", "src/y.ts"],
          imports: [importOf("src/x.ts", "express", { type: "package", name: "express" })],
        }),
      });
      const express = await read(a, (client) => findNode(client, runId, "module", "express"));
      const y = await read(a, (client) => findNode(client, runId, "file", "src/y.ts"));
      if (express === null || y === null) throw new Error("fixture");
      await h.admin.query(
        `INSERT INTO graph_edges (organisation_id, run_id, from_id, to_id, kind) VALUES ($1, $2, $3, $4, 'imports')`,
        [a.organisationId, runId, express.id, y.id],
      );
      const reached = await read(a, (client) =>
        importClosure(client, runId, "src/x.ts", { direction: "imports" }),
      );
      expect(reached).toEqual([]);
    });
  });

  describe("a run id that two organisations both use", () => {
    // The key of a run is the organisation and the id, so two organisations can use the same id.
    // Each must see its own graph and no part of the other's, with row-level security or without.
    let shared: string;
    const own = (organisationId: string): TenantClient => ({
      organisationId,
      query: (text, values) => h.admin.query(text, values),
    });

    beforeAll(async () => {
      shared = randomUUID();
      await save(a, { runId: shared, projectId: a.projectId, facts: cycleFacts() });
      const internal = (path: string) => ({ type: "internal" as const, path });
      await save(b, {
        runId: shared,
        projectId: b.projectId,
        facts: makeFacts({
          // A file that sorts before the others, so that the numbers of B's nodes are not A's, and
          // one that imports something of its own.
          files: ["src/0.ts", "src/a.ts", "src/b.ts", "src/q.ts", "src/z.ts"],
          imports: [
            importOf("src/0.ts", "./q.js", internal("src/q.ts")),
            importOf("src/a.ts", "./z.js", internal("src/z.ts")),
            importOf("src/z.ts", "./b.js", internal("src/b.ts")),
          ],
        }),
      });
    });

    const both = async <T>(
      tenant: Tenant,
      work: (client: TenantClient) => Promise<T>,
    ): Promise<[T, T]> => [await read(tenant, work), await work(own(tenant.organisationId))];

    it("gives each its own run", async () => {
      const [aRls, aBare] = await both(a, (c) => getRun(c, shared));
      expect(aRls?.nodeCount).toBe(6);
      expect(aBare?.nodeCount).toBe(6);
      const [bRls, bBare] = await both(b, (c) => getRun(c, shared));
      expect(bRls?.nodeCount).toBe(5);
      expect(bBare?.nodeCount).toBe(5);
    });

    it("gives each its own nodes", async () => {
      const [rls, bare] = await both(b, (c) => listNodes(c, shared));
      expect(rls.map((node) => node.key)).toEqual([
        "src/0.ts",
        "src/a.ts",
        "src/b.ts",
        "src/q.ts",
        "src/z.ts",
      ]);
      expect(bare).toEqual(rls);
      const [foundRls, foundBare] = await both(b, (c) => findNode(c, shared, "file", "src/c.ts"));
      expect(foundRls).toBeNull();
      expect(foundBare).toBeNull();
      const [aRls, aBare] = await both(a, (c) => listNodes(c, shared));
      expect(aRls).toHaveLength(6);
      expect(aBare).toEqual(aRls);
    });

    it("gives each its own edges", async () => {
      const bFile = await read(b, (c) => findNode(c, shared, "file", "src/a.ts"));
      if (bFile === null) throw new Error("fixture");
      // In A's run the same number is another file, with other edges.
      expect(bFile.id).not.toBe(0);
      for (const [direction, expected] of [
        ["out", ["imports file:src/z.ts"]],
        ["in", []],
      ] as const) {
        const [rls, bare] = await both(b, (c) => neighbours(c, shared, bFile.id, { direction }));
        const named = (found: typeof rls) =>
          found.map((entry) => `${entry.edge.kind} ${entry.node.kind}:${entry.node.key}`);
        expect(named(rls)).toEqual(expected);
        expect(named(bare)).toEqual(expected);
      }
      const [aRls, aBare] = await both(a, (c) => neighbours(c, shared, 0, { direction: "out" }));
      expect(aRls).toHaveLength(2);
      expect(aBare).toEqual(aRls);
    });

    it("gives each its own closure", async () => {
      const [rls, bare] = await both(b, (c) =>
        importClosure(c, shared, "src/a.ts", { direction: "imports" }),
      );
      expect(files(rls)).toEqual(["src/z.ts:1", "src/b.ts:2"]);
      expect(files(bare)).toEqual(files(rls));
      const [into, intoBare] = await both(b, (c) =>
        importClosure(c, shared, "src/b.ts", { direction: "importers" }),
      );
      expect(files(into)).toEqual(["src/z.ts:1", "src/a.ts:2"]);
      expect(files(intoBare)).toEqual(files(into));
      const [aRls, aBare] = await both(a, (c) =>
        importClosure(c, shared, "src/a.ts", { direction: "imports" }),
      );
      expect(files(aRls)).toEqual(["src/b.ts:1", "src/c.ts:2"]);
      expect(files(aBare)).toEqual(files(aRls));
    });
  });

  describe("when row-level security is not there to help", () => {
    // Every read names the organisation as well as relying on row-level security, so that a mistake
    // in one is not a leak by the other. Here the client is a superuser's, which row-level security
    // does not apply to, saying that it acts for B: it must still see nothing of A's.
    const unprotected = (): TenantClient => ({
      organisationId: b.organisationId,
      query: (text, values) => h.admin.query(text, values),
    });

    it("still shows an organisation nothing of a run of another", async () => {
      const client = unprotected();
      const node = await read(a, (own) => findNode(own, shopRun, "file", "apps/api/src/server.ts"));
      if (node === null) throw new Error("fixture");
      expect(await getRun(client, shopRun)).toBeNull();
      expect(await latestRun(client, a.projectId)).toBeNull();
      expect(await findNode(client, shopRun, "file", "apps/api/src/server.ts")).toBeNull();
      expect(await listNodes(client, shopRun)).toEqual([]);
      expect(await neighbours(client, shopRun, node.id, { direction: "out" })).toEqual([]);
      expect(await neighbours(client, shopRun, node.id, { direction: "in" })).toEqual([]);
      expect(await importClosure(client, cycleRun, "src/c.ts", { direction: "importers" })).toEqual(
        [],
      );
      expect(await importClosure(client, cycleRun, "src/a.ts", { direction: "imports" })).toEqual(
        [],
      );
    });

    it("does show it what is its own", async () => {
      expect(await getRun(unprotected(), foreignRun)).toMatchObject({ projectId: b.projectId });
    });
  });

  describe("what is refused", () => {
    const bad = (work: (client: TenantClient) => Promise<unknown>) => graphErrorCode(read(a, work));

    it.each([
      ["a run id that is not a UUID", (c: TenantClient) => getRun(c, "nope")],
      ["a project id that is not a UUID", (c: TenantClient) => latestRun(c, "nope")],
      [
        "a run id that is not a UUID, to find a node",
        (c: TenantClient) => findNode(c, "nope", "file", "x"),
      ],
      ["a limit of zero", (c: TenantClient) => listNodes(c, cycleRun, { limit: 0 })],
      ["a limit over the largest", (c: TenantClient) => listNodes(c, cycleRun, { limit: 10_001 })],
      ["a limit that is not whole", (c: TenantClient) => listNodes(c, cycleRun, { limit: 1.5 })],
      [
        "a page start that is not whole",
        (c: TenantClient) => listNodes(c, cycleRun, { afterId: 1.5 }),
      ],
      [
        "a node id below zero",
        (c: TenantClient) => neighbours(c, cycleRun, -1, { direction: "out" }),
      ],
      [
        "a node id that is not whole",
        (c: TenantClient) => neighbours(c, cycleRun, 0.5, { direction: "out" }),
      ],
      [
        "a direction that is not one",
        (c: TenantClient) => neighbours(c, cycleRun, 0, { direction: "sideways" as "out" }),
      ],
      [
        "a direction that is SQL",
        (c: TenantClient) =>
          neighbours(c, cycleRun, 0, { direction: "out; DROP TABLE graph_edges; --" as "out" }),
      ],
      [
        "a closure direction that is not one",
        (c: TenantClient) =>
          importClosure(c, cycleRun, "src/a.ts", { direction: "both" as "imports" }),
      ],
      [
        "a depth of zero",
        (c: TenantClient) =>
          importClosure(c, cycleRun, "src/a.ts", { direction: "imports", maxDepth: 0 }),
      ],
      [
        "a depth over the largest",
        (c: TenantClient) =>
          importClosure(c, cycleRun, "src/a.ts", { direction: "imports", maxDepth: 51 }),
      ],
      [
        "a closure limit of zero",
        (c: TenantClient) =>
          importClosure(c, cycleRun, "src/a.ts", { direction: "imports", limit: 0 }),
      ],
    ] as const)("%s", async (_name, work) => {
      await expect(bad(work)).resolves.toBe("invalid_input");
    });

    it("leaves the tables as they were after a direction that is SQL", async () => {
      const count = await h.admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM graph_edges WHERE run_id = $1",
        [cycleRun],
      );
      expect(count.rows[0]?.n).toBe(buildGraph(cycleFacts()).edges.length);
    });
  });
});
