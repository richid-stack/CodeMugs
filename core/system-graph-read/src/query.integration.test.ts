import { randomUUID } from "node:crypto";
import { withTenant, type TenantClient } from "@codemugs/storage";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDatabase, startHarness } from "./db-harness.js";
import type { Harness, Tenant } from "./db-harness.js";
import { findNode, getRun, importClosure, latestRun, listNodes, neighbours } from "./index.js";

// These runs are written by hand, with the superuser, and not by the builder: what a reader needs is
// the tables, and this package has to be shown to work without the code that fills them. The builder's
// own tests (`@codemugs/system-graph`) read what it stored through these same functions.

const DIGEST = "a".repeat(64);

/** Files a, b and c import each other in a ring (a→b→c→a), and a imports the module express. */
const NODES = [
  { id: 0, kind: "file", key: "src/a.ts" },
  { id: 1, kind: "file", key: "src/b.ts" },
  { id: 2, kind: "file", key: "src/c.ts" },
  { id: 3, kind: "module", key: "express" },
] as const;
const EDGES = [
  { from: 0, to: 1 },
  { from: 1, to: 2 },
  { from: 2, to: 0 },
  { from: 0, to: 3 },
] as const;

describeDatabase("reading the system graph without the builder", () => {
  let h: Harness;
  let a: Tenant;
  let b: Tenant;
  let first: string;
  let second: string;
  let foreign: string;

  async function seed(tenant: Tenant, runId: string, projectId: string): Promise<void> {
    await h.admin.query(
      `INSERT INTO analysis_runs (organisation_id, id, project_id, facts_version, summary,
                                  node_count, edge_count, digest, truncated)
       VALUES ($1, $2, $3, 1, '{"files": 3}', $4, $5, $6, ARRAY['imports'])`,
      [tenant.organisationId, runId, projectId, NODES.length, EDGES.length, DIGEST],
    );
    for (const node of NODES) {
      await h.admin.query(
        `INSERT INTO graph_nodes (organisation_id, run_id, id, kind, key) VALUES ($1, $2, $3, $4, $5)`,
        [tenant.organisationId, runId, node.id, node.kind, node.key],
      );
    }
    for (const edge of EDGES) {
      await h.admin.query(
        `INSERT INTO graph_edges (organisation_id, run_id, from_id, to_id, kind)
         VALUES ($1, $2, $3, $4, 'imports')`,
        [tenant.organisationId, runId, edge.from, edge.to],
      );
    }
  }

  beforeAll(async () => {
    h = await startHarness();
    a = await h.tenant("A");
    b = await h.tenant("B");
    first = randomUUID();
    second = randomUUID();
    foreign = randomUUID();
    // Stored in this order: the second is the graph now.
    await seed(a, first, a.projectId);
    await seed(a, second, a.projectId);
    await seed(b, foreign, b.projectId);
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  // Every read is in a read-only transaction: it needs no write.
  const read = <T>(tenant: Tenant, work: (client: TenantClient) => Promise<T>) =>
    withTenant(h.app, tenant.organisationId, work, { readOnly: true });
  const keys = (nodes: Array<{ key: string }>) => nodes.map((node) => node.key);

  it("gives a run as it is stored, and the one stored last as the graph now", async () => {
    expect(await read(a, (client) => getRun(client, first))).toMatchObject({
      id: first,
      projectId: a.projectId,
      revision: null,
      factsVersion: 1,
      truncated: ["imports"],
      summary: { files: 3 },
      nodeCount: 4,
      edgeCount: 4,
      digest: DIGEST,
    });
    expect((await read(a, (client) => latestRun(client, a.projectId)))?.id).toBe(second);
    expect(await read(a, (client) => latestRun(client, a.otherProjectId))).toBeNull();
  });

  it("lists nodes in the order of their ids, a page at a time, and by kind", async () => {
    expect(keys(await read(a, (client) => listNodes(client, second)))).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "express",
    ]);
    const page = await read(a, (client) => listNodes(client, second, { limit: 2, afterId: 0 }));
    expect(keys(page)).toEqual(["src/b.ts", "src/c.ts"]);
    expect(keys(await read(a, (client) => listNodes(client, second, { kind: "module" })))).toEqual([
      "express",
    ]);
    expect(await read(a, (client) => findNode(client, second, "file", "src/b.ts"))).toMatchObject({
      id: 1,
      kind: "file",
    });
    expect(await read(a, (client) => findNode(client, second, "file", "express"))).toBeNull();
  });

  it("follows the edges of a node, out and in", async () => {
    const out = await read(a, (client) => neighbours(client, second, 0, { direction: "out" }));
    expect(out.map((entry) => entry.node.key)).toEqual(["src/b.ts", "express"]);
    const into = await read(a, (client) =>
      neighbours(client, second, 0, { direction: "in", kind: "imports" }),
    );
    expect(into.map((entry) => entry.node.key)).toEqual(["src/c.ts"]);
    expect(
      await read(a, (client) =>
        neighbours(client, second, 0, { direction: "in", kind: "nothing" }),
      ),
    ).toEqual([]);
  });

  it("walks imports through a ring once, and finds no files from what is not a file", async () => {
    const importers = await read(a, (client) =>
      importClosure(client, second, "src/a.ts", { direction: "importers" }),
    );
    expect(importers.map((entry) => `${entry.node.key}:${String(entry.depth)}`)).toEqual([
      "src/c.ts:1",
      "src/b.ts:2",
    ]);
    const imports = await read(a, (client) =>
      importClosure(client, second, "src/a.ts", { direction: "imports", maxDepth: 1 }),
    );
    expect(keys(imports.map((entry) => entry.node))).toEqual(["src/b.ts"]);
    expect(
      await read(a, (client) => importClosure(client, second, "express", { direction: "imports" })),
    ).toEqual([]);
  });

  it("shows another organisation nothing of this one, and this one nothing of theirs", async () => {
    expect(await read(b, (client) => getRun(client, second))).toBeNull();
    expect(await read(b, (client) => latestRun(client, a.projectId))).toBeNull();
    expect(await read(b, (client) => listNodes(client, second))).toEqual([]);
    expect(await read(b, (client) => findNode(client, second, "file", "src/a.ts"))).toBeNull();
    expect(await read(b, (client) => neighbours(client, second, 0, { direction: "out" }))).toEqual(
      [],
    );
    expect(
      await read(b, (client) =>
        importClosure(client, second, "src/a.ts", { direction: "imports" }),
      ),
    ).toEqual([]);
    expect(await read(a, (client) => getRun(client, foreign))).toBeNull();
    expect(await read(a, (client) => listNodes(client, foreign))).toEqual([]);
  });
});
