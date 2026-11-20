import { randomUUID } from "node:crypto";
import { withTenant, type TenantClient } from "@codemugs/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGraph } from "./build.js";
import { databaseErrorCode, describeDatabase, graphErrorCode, startHarness } from "./db-harness.js";
import type { Harness, Tenant } from "./db-harness.js";
import { saveAnalysis, type SaveAnalysisInput } from "./store.js";
import { importOf, makeFacts, shopFacts } from "./test-harness.js";

const REVISION = "0123456789abcdef0123456789abcdef01234567";

describeDatabase("saving an analysis in PostgreSQL", () => {
  let h: Harness;
  let a: Tenant;
  let b: Tenant;

  beforeAll(async () => {
    h = await startHarness();
    a = await h.tenant("A");
    b = await h.tenant("B");
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  const save = (tenant: Tenant, input: SaveAnalysisInput) =>
    withTenant(h.app, tenant.organisationId, (client) => saveAnalysis(client, input));

  interface RunRow {
    organisation_id: string;
    id: string;
    project_id: string;
    revision: string | null;
    facts_version: number;
    truncated: string[];
    summary: Record<string, unknown>;
    node_count: number;
    edge_count: number;
    digest: string;
    analysed_at: Date;
  }
  interface NodeRow {
    organisation_id: string;
    id: number;
    kind: string;
    key: string;
    attributes: Record<string, unknown>;
  }
  interface EdgeRow {
    organisation_id: string;
    from_id: number;
    to_id: number;
    kind: string;
    attributes: Record<string, unknown>;
  }

  /** What is really stored for a run, as the superuser sees it. */
  async function stored(runId: string) {
    const [runs, nodes, edges] = await Promise.all([
      h.admin.query<RunRow>(`SELECT * FROM analysis_runs WHERE id = $1 ORDER BY organisation_id`, [
        runId,
      ]),
      h.admin.query<NodeRow>(
        `SELECT * FROM graph_nodes WHERE run_id = $1 ORDER BY organisation_id, id`,
        [runId],
      ),
      h.admin.query<EdgeRow>(
        `SELECT * FROM graph_edges WHERE run_id = $1 ORDER BY organisation_id, from_id, to_id, kind`,
        [runId],
      ),
    ]);
    return { runs: runs.rows, nodes: nodes.rows, edges: edges.rows };
  }

  describe("what is stored", () => {
    it("is the run, its nodes and its edges, as the builder made them", async () => {
      const runId = randomUUID();
      const expected = buildGraph(shopFacts());
      const saved = await save(a, {
        runId,
        projectId: a.projectId,
        revision: REVISION,
        facts: shopFacts(),
      });
      expect(saved).toEqual({
        runId,
        duplicate: false,
        nodes: expected.nodes.length,
        edges: expected.edges.length,
      });

      const rows = await stored(runId);
      expect(rows.runs).toHaveLength(1);
      expect(rows.runs[0]).toMatchObject({
        organisation_id: a.organisationId,
        id: runId,
        project_id: a.projectId,
        revision: REVISION,
        facts_version: 1,
        truncated: [],
        summary: expected.summary,
        node_count: expected.nodes.length,
        edge_count: expected.edges.length,
        digest: expected.digest,
      });
      expect(rows.runs[0]?.analysed_at).toBeInstanceOf(Date);
      expect(
        rows.nodes.map((row) => ({
          id: row.id,
          kind: row.kind,
          key: row.key,
          attributes: row.attributes,
        })),
      ).toEqual(expected.nodes);
      expect(rows.nodes.every((row) => row.organisation_id === a.organisationId)).toBe(true);
      expect(
        rows.edges.map((row) => ({
          from: row.from_id,
          to: row.to_id,
          kind: row.kind,
          attributes: row.attributes,
        })),
      ).toEqual(expected.edges);
      expect(rows.edges.every((row) => row.organisation_id === a.organisationId)).toBe(true);
    });

    it("keeps what the analysis cut short, and has no revision when none is known", async () => {
      const runId = randomUUID();
      await save(a, {
        runId,
        projectId: a.projectId,
        facts: makeFacts({ files: ["a.ts"], truncated: ["imports", "time"] }),
      });
      const [run] = (await stored(runId)).runs;
      expect(run).toMatchObject({ revision: null, truncated: ["imports", "time"] });
    });

    it("can be a graph with no edges", async () => {
      const runId = randomUUID();
      const saved = await save(a, {
        runId,
        projectId: a.projectId,
        facts: makeFacts({ files: ["only.ts"] }),
      });
      expect(saved).toEqual({ runId, duplicate: false, nodes: 1, edges: 0 });
      expect((await stored(runId)).edges).toEqual([]);
    });

    it("keeps names that look like code as the data that they are", async () => {
      const runId = randomUUID();
      const names = [
        "a'; DROP TABLE graph_nodes; --.ts",
        "$(touch pwned).ts",
        "spaces and 'quotes' and \"double\".ts",
      ];
      await save(a, { runId, projectId: a.projectId, facts: makeFacts({ files: names }) });
      const rows = await stored(runId);
      expect(rows.nodes.map((row) => row.key).sort()).toEqual([...names].sort());
      // The table that the first name tries to drop is still there, and still has the run's nodes.
      expect(rows.nodes).toHaveLength(3);
    });
  });

  describe("a second time", () => {
    it("is a retry when the id and the facts are the same, and changes nothing", async () => {
      const runId = randomUUID();
      const first = await save(a, { runId, projectId: a.projectId, facts: shopFacts() });
      const before = await stored(runId);
      const again = await save(a, { runId, projectId: a.projectId, facts: shopFacts() });
      expect(again).toEqual({ ...first, duplicate: true });
      expect(await stored(runId)).toEqual(before);
    });

    it("is a retry whatever order the facts are listed in", async () => {
      const runId = randomUUID();
      const facts = shopFacts();
      await save(a, { runId, projectId: a.projectId, facts });
      const reversed = {
        ...facts,
        files: [...facts.files].reverse(),
        imports: [...facts.imports].reverse(),
        routes: [...facts.routes].reverse(),
      };
      const again = await save(a, { runId, projectId: a.projectId, facts: reversed });
      expect(again.duplicate).toBe(true);
    });

    it("is refused when the id is the same and the facts are not, and changes nothing", async () => {
      const runId = randomUUID();
      await save(a, { runId, projectId: a.projectId, facts: shopFacts() });
      const before = await stored(runId);
      const other = makeFacts({ files: ["something-else.ts"] });
      await expect(
        graphErrorCode(save(a, { runId, projectId: a.projectId, facts: other })),
      ).resolves.toBe("run_conflict");
      expect(await stored(runId)).toEqual(before);
    });

    it("is a retry when the ids are written in capitals the second time", async () => {
      const runId = randomUUID();
      const first = await save(a, { runId, projectId: a.projectId, facts: shopFacts() });
      const again = await save(a, {
        runId: runId.toUpperCase(),
        projectId: a.projectId.toUpperCase(),
        facts: shopFacts(),
      });
      expect(again).toEqual({ ...first, duplicate: true });
    });

    it("says the id of a run in lower case, however it was written", async () => {
      const runId = randomUUID();
      const saved = await save(a, {
        runId: runId.toUpperCase(),
        projectId: a.projectId.toUpperCase(),
        facts: shopFacts(),
      });
      expect(saved.runId).toBe(runId);
      expect((await stored(runId)).runs).toHaveLength(1);
    });

    describe("with the same id and the same graph but not the same run", () => {
      it("is refused when the revision is another", async () => {
        const runId = randomUUID();
        await save(a, { runId, projectId: a.projectId, revision: REVISION, facts: shopFacts() });
        const before = await stored(runId);
        const other = "fedcba9876543210fedcba9876543210fedcba98";
        await expect(
          graphErrorCode(
            save(a, { runId, projectId: a.projectId, revision: other, facts: shopFacts() }),
          ),
        ).resolves.toBe("run_conflict");
        expect(await stored(runId)).toEqual(before);
      });

      it("is refused when a revision is given the second time and was not the first", async () => {
        const runId = randomUUID();
        await save(a, { runId, projectId: a.projectId, facts: shopFacts() });
        await expect(
          graphErrorCode(
            save(a, { runId, projectId: a.projectId, revision: REVISION, facts: shopFacts() }),
          ),
        ).resolves.toBe("run_conflict");
      });

      it("is refused when the revision was given the first time and is not the second", async () => {
        const runId = randomUUID();
        await save(a, { runId, projectId: a.projectId, revision: REVISION, facts: shopFacts() });
        await expect(
          graphErrorCode(save(a, { runId, projectId: a.projectId, facts: shopFacts() })),
        ).resolves.toBe("run_conflict");
      });

      it("is refused when the analysis cut something else short, and changes nothing", async () => {
        const runId = randomUUID();
        const files = ["a.ts", "b.ts"];
        await save(a, { runId, projectId: a.projectId, facts: makeFacts({ files }) });
        const before = await stored(runId);
        const cut = makeFacts({ files, truncated: ["imports"] });
        await expect(
          graphErrorCode(save(a, { runId, projectId: a.projectId, facts: cut })),
        ).resolves.toBe("run_conflict");
        expect(await stored(runId)).toEqual(before);
      });

      it("is refused when the analysis skipped something else, and changes nothing", async () => {
        const runId = randomUUID();
        const facts = makeFacts({ files: ["a.ts", "b.ts"] });
        await save(a, { runId, projectId: a.projectId, facts });
        const before = await stored(runId);
        const skipped = {
          ...facts,
          limits: { ...facts.limits, skipped: { ...facts.limits.skipped, tooLarge: 2 } },
        };
        await expect(
          graphErrorCode(save(a, { runId, projectId: a.projectId, facts: skipped })),
        ).resolves.toBe("run_conflict");
        expect(await stored(runId)).toEqual(before);
      });

      it("is a retry when what was cut short is listed in another order", async () => {
        const runId = randomUUID();
        const files = ["a.ts", "b.ts"];
        await save(a, {
          runId,
          projectId: a.projectId,
          facts: makeFacts({ files, truncated: ["time", "imports", "files"] }),
        });
        const again = await save(a, {
          runId,
          projectId: a.projectId,
          facts: makeFacts({ files, truncated: ["files", "time", "imports"] }),
        });
        expect(again.duplicate).toBe(true);
      });
    });

    it("is refused when the graph is another with the same counts and limits, and changes nothing", async () => {
      // One file each, so the summary of the two analyses is the same: only the graph tells them apart.
      const runId = randomUUID();
      await save(a, { runId, projectId: a.projectId, facts: makeFacts({ files: ["one.ts"] }) });
      const before = await stored(runId);
      await expect(
        graphErrorCode(
          save(a, { runId, projectId: a.projectId, facts: makeFacts({ files: ["two.ts"] }) }),
        ),
      ).resolves.toBe("run_conflict");
      expect(await stored(runId)).toEqual(before);
    });

    it("is refused when the id and the facts are the same but the project is not", async () => {
      const runId = randomUUID();
      await save(a, { runId, projectId: a.projectId, facts: shopFacts() });
      const before = await stored(runId);
      await expect(
        graphErrorCode(save(a, { runId, projectId: a.otherProjectId, facts: shopFacts() })),
      ).resolves.toBe("run_conflict");
      expect(await stored(runId)).toEqual(before);
    });
  });

  describe("what is refused, with nothing stored", () => {
    const facts = shopFacts();
    const unlisted = {
      ...facts,
      imports: [importOf("package.json", "./x.js", { type: "internal", path: "ghost.ts" })],
    };

    it.each([
      ["a run id that is not a UUID", { runId: "not-a-uuid" }, "invalid_input"],
      ["a project id that is not a UUID", { projectId: "not-a-uuid" }, "invalid_input"],
      ["a revision in capitals", { revision: REVISION.toUpperCase() }, "invalid_input"],
      ["a revision that is too short", { revision: REVISION.slice(0, 39) }, "invalid_input"],
      ["a revision that is not hexadecimal", { revision: "z".repeat(40) }, "invalid_input"],
      ["facts of another version", { facts: { ...facts, version: 2 } }, "facts_rejected"],
      [
        "facts with a field that is not in the schema",
        { facts: { ...facts, extra: 1 } },
        "facts_rejected",
      ],
      ["facts that are not an object", { facts: "nothing" }, "facts_rejected"],
      ["an import of a file that is not listed", { facts: unlisted }, "facts_rejected"],
    ] as const)("%s", async (_name, change, code) => {
      const runId = randomUUID();
      const input = {
        runId,
        projectId: a.projectId,
        facts,
        ...change,
      } as unknown as SaveAnalysisInput;
      const attempted = input.runId === runId ? runId : undefined;
      await expect(graphErrorCode(save(a, input))).resolves.toBe(code);
      if (attempted !== undefined) expect((await stored(attempted)).runs).toEqual([]);
    });

    it("says nothing of the facts in the error", async () => {
      const secret = "secret-file-name";
      const bad = {
        ...facts,
        imports: [importOf("package.json", "./x.js", { type: "internal", path: `${secret}.ts` })],
      };
      const error = await save(a, { runId: randomUUID(), projectId: a.projectId, facts: bad }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect((error as Error).message).not.toContain(secret);
    });
  });

  describe("when the write fails half way", () => {
    /** A client that fails on the statement that holds this text and does the rest for real. */
    const failingOn =
      (text: string) =>
      (client: TenantClient): TenantClient => ({
        organisationId: client.organisationId,
        query: (sql, values) =>
          sql.includes(text)
            ? Promise.reject(new Error("injected failure"))
            : client.query(sql, values),
      });

    it.each([["INSERT INTO graph_nodes"], ["INSERT INTO graph_edges"]])(
      "leaves nothing behind when %s fails",
      async (text) => {
        const runId = randomUUID();
        await expect(
          withTenant(h.app, a.organisationId, (client) =>
            saveAnalysis(failingOn(text)(client), {
              runId,
              projectId: a.projectId,
              facts: shopFacts(),
            }),
          ),
        ).rejects.toThrow("injected failure");
        expect(await stored(runId)).toEqual({ runs: [], nodes: [], edges: [] });
        // And the same run can be stored afterwards, in full.
        const saved = await save(a, { runId, projectId: a.projectId, facts: shopFacts() });
        expect(saved.duplicate).toBe(false);
      },
    );
  });

  describe("when the run that is in the way cannot be read", () => {
    it("is refused as a conflict, and not as a crash", async () => {
      const runId = randomUUID();
      await save(a, { runId, projectId: a.projectId, facts: shopFacts() });
      // The one read that saveAnalysis makes is the one of the run that is in the way.
      const blind = (client: TenantClient): TenantClient => ({
        organisationId: client.organisationId,
        query: (sql, values) =>
          /^\s*SELECT/i.test(sql)
            ? Promise.resolve({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] })
            : client.query(sql, values),
      });
      await expect(
        graphErrorCode(
          withTenant(h.app, a.organisationId, (client) =>
            saveAnalysis(blind(client), { runId, projectId: a.projectId, facts: shopFacts() }),
          ),
        ),
      ).resolves.toBe("run_conflict");
    });
  });

  describe("many at once", () => {
    it("stores a run once when the same analysis is stored at the same time many times", async () => {
      const runId = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          save(a, { runId, projectId: a.projectId, facts: shopFacts() }),
        ),
      );
      expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
      const expected = buildGraph(shopFacts());
      for (const result of results) {
        expect(result).toMatchObject({
          nodes: expected.nodes.length,
          edges: expected.edges.length,
        });
      }
      const rows = await stored(runId);
      expect(rows.runs).toHaveLength(1);
      expect(rows.nodes).toHaveLength(expected.nodes.length);
      expect(rows.edges).toHaveLength(expected.edges.length);
    });

    it("lets one analysis win and refuses the others when they differ", async () => {
      const runId = randomUUID();
      const variants = [shopFacts(), makeFacts({ files: ["one.ts", "two.ts"] })];
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) =>
          save(a, { runId, projectId: a.projectId, facts: variants[index % 2] ?? shopFacts() }),
        ),
      );
      const rows = await stored(runId);
      expect(rows.runs).toHaveLength(1);
      const winner = rows.runs[0]?.digest;
      outcomes.forEach((outcome, index) => {
        const digest = buildGraph(variants[index % 2] ?? shopFacts()).digest;
        if (digest === winner) {
          expect(outcome.status).toBe("fulfilled");
        } else {
          expect(outcome.status).toBe("rejected");
          expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: "run_conflict" });
        }
      });
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled" && !outcome.value.duplicate),
      ).toHaveLength(1);
      expect(rows.nodes).toHaveLength(rows.runs[0]?.node_count as number);
      expect(rows.edges).toHaveLength(rows.runs[0]?.edge_count as number);
    });
  });

  describe("between organisations", () => {
    it("cannot be stored in the project of another organisation, and says no more than for a project that does not exist", async () => {
      const intoOther = randomUUID();
      const intoNowhere = randomUUID();
      const foreign = await save(b, {
        runId: intoOther,
        projectId: a.projectId,
        facts: shopFacts(),
      }).then(
        () => undefined,
        (caught: unknown) => caught as Error & { code: string },
      );
      const missing = await save(b, {
        runId: intoNowhere,
        projectId: randomUUID(),
        facts: shopFacts(),
      }).then(
        () => undefined,
        (caught: unknown) => caught as Error & { code: string },
      );
      expect(foreign).toMatchObject({ code: "project_not_found" });
      expect(missing).toMatchObject({ code: "project_not_found" });
      expect(foreign?.message).toBe(missing?.message);
      expect(foreign?.message).not.toContain(a.projectId);
      expect(await stored(intoOther)).toEqual({ runs: [], nodes: [], edges: [] });
      expect(await stored(intoNowhere)).toEqual({ runs: [], nodes: [], edges: [] });
    });

    it("has a run id of its own: the same id in two organisations is two runs, and neither shows the other", async () => {
      const runId = randomUUID();
      await save(a, { runId, projectId: a.projectId, facts: shopFacts() });
      const other = makeFacts({ files: ["b-only.ts"] });
      const saved = await save(b, { runId, projectId: b.projectId, facts: other });
      // Not a conflict, and not a retry: to B there was never a run with this id.
      expect(saved).toEqual({ runId, duplicate: false, nodes: 1, edges: 0 });
      const rows = await stored(runId);
      expect(rows.runs.map((run) => [run.organisation_id, run.node_count]).sort()).toEqual(
        [
          [a.organisationId, buildGraph(shopFacts()).nodes.length],
          [b.organisationId, 1],
        ].sort(),
      );
    });

    it("takes the organisation from the transaction and from nothing that the caller passes", async () => {
      const runId = randomUUID();
      const input = {
        runId,
        projectId: a.projectId,
        facts: shopFacts(),
        // What a caller must not be able to do (invariant 1). It is not in the type, and it is ignored.
        organisationId: b.organisationId,
      } as unknown as SaveAnalysisInput;
      await save(a, input);
      const rows = await stored(runId);
      expect(rows.runs.map((run) => run.organisation_id)).toEqual([a.organisationId]);
      expect(rows.nodes.every((row) => row.organisation_id === a.organisationId)).toBe(true);
    });

    describe("in SQL that does not go through this package", () => {
      let runA: string;

      beforeAll(async () => {
        runA = randomUUID();
        await save(a, { runId: runA, projectId: a.projectId, facts: shopFacts() });
      });

      it.each(["analysis_runs", "graph_nodes", "graph_edges"])(
        "shows %s of the organisation and none of another",
        async (table) => {
          const own = await h.admin.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM ${table} WHERE organisation_id = $1`,
            [b.organisationId],
          );
          const seen = await withTenant(h.app, b.organisationId, (client) =>
            client.query<{ n: number; others: number }>(
              `SELECT count(*)::int AS n, count(*) FILTER (WHERE organisation_id <> $1)::int AS others FROM ${table}`,
              [b.organisationId],
            ),
          );
          expect(seen.rows[0]).toEqual({ n: own.rows[0]?.n, others: 0 });
          const named = await withTenant(h.app, b.organisationId, (client) =>
            client.query(
              `SELECT 1 FROM ${table} WHERE ${table === "analysis_runs" ? "id" : "run_id"} = $1`,
              [runA],
            ),
          );
          expect(named.rowCount).toBe(0);
        },
      );

      it("shows nothing when no organisation is set", async () => {
        for (const table of ["analysis_runs", "graph_nodes", "graph_edges"]) {
          const result = await h.app.query(`SELECT 1 FROM ${table}`);
          expect(result.rowCount).toBe(0);
        }
      });

      it("does not let rows be written for another organisation", async () => {
        const insertRun = `INSERT INTO analysis_runs (organisation_id, id, project_id, facts_version, summary, node_count, edge_count, digest)
                           VALUES ($1, $2, $3, 1, '{}', 0, 0, $4)`;
        const digest = "0".repeat(64);
        // A row for A, written as B (RLS says no).
        await expect(
          databaseErrorCode(
            withTenant(h.app, b.organisationId, (client) =>
              client.query(insertRun, [a.organisationId, randomUUID(), a.projectId, digest]),
            ),
          ),
        ).resolves.toBe("42501");
        await expect(
          databaseErrorCode(
            withTenant(h.app, b.organisationId, (client) =>
              client.query(
                `INSERT INTO graph_nodes (organisation_id, run_id, id, kind, key) VALUES ($1, $2, 99, 'file', 'x.ts')`,
                [a.organisationId, runA],
              ),
            ),
          ),
        ).resolves.toBe("42501");
        await expect(
          databaseErrorCode(
            withTenant(h.app, b.organisationId, (client) =>
              client.query(
                `INSERT INTO graph_edges (organisation_id, run_id, from_id, to_id, kind) VALUES ($1, $2, 0, 1, 'imports')`,
                [a.organisationId, runA],
              ),
            ),
          ),
        ).resolves.toBe("42501");
      });

      it("does not let B's rows point into A's run or A's project", async () => {
        const digest = "0".repeat(64);
        // A run of B's, in A's project: the foreign key carries the organisation, so it finds none.
        await expect(
          databaseErrorCode(
            withTenant(h.app, b.organisationId, (client) =>
              client.query(
                `INSERT INTO analysis_runs (organisation_id, id, project_id, facts_version, summary, node_count, edge_count, digest)
                 VALUES ($1, $2, $3, 1, '{}', 0, 0, $4)`,
                [b.organisationId, randomUUID(), a.projectId, digest],
              ),
            ),
          ),
        ).resolves.toBe("23503");
        // A node of B's, in A's run.
        await expect(
          databaseErrorCode(
            withTenant(h.app, b.organisationId, (client) =>
              client.query(
                `INSERT INTO graph_nodes (organisation_id, run_id, id, kind, key) VALUES ($1, $2, 99, 'file', 'x.ts')`,
                [b.organisationId, runA],
              ),
            ),
          ),
        ).resolves.toBe("23503");
        // An edge of B's, between A's nodes.
        await expect(
          databaseErrorCode(
            withTenant(h.app, b.organisationId, (client) =>
              client.query(
                `INSERT INTO graph_edges (organisation_id, run_id, from_id, to_id, kind) VALUES ($1, $2, 0, 1, 'imports')`,
                [b.organisationId, runA],
              ),
            ),
          ),
        ).resolves.toBe("23503");
      });
    });
  });

  describe("kept as it was written", () => {
    let runId: string;

    beforeAll(async () => {
      runId = randomUUID();
      await save(a, { runId, projectId: a.projectId, facts: shopFacts() });
    });

    it.each([
      ["UPDATE analysis_runs SET node_count = 0 WHERE id = $1"],
      ["UPDATE graph_nodes SET key = 'changed' WHERE run_id = $1"],
      ["UPDATE graph_edges SET kind = 'changed' WHERE run_id = $1"],
      ["DELETE FROM analysis_runs WHERE id = $1"],
      ["DELETE FROM graph_nodes WHERE run_id = $1"],
      ["DELETE FROM graph_edges WHERE run_id = $1"],
    ])("is not changed or deleted by the application: %s", async (sql) => {
      const before = await stored(runId);
      await expect(
        databaseErrorCode(
          withTenant(h.app, a.organisationId, (client) => client.query(sql, [runId])),
        ),
      ).resolves.toBe("42501");
      expect(await stored(runId)).toEqual(before);
    });

    it.each(["analysis_runs", "graph_nodes", "graph_edges"])(
      "is not truncated by the application: %s",
      async (table) => {
        await expect(
          databaseErrorCode(
            withTenant(h.app, a.organisationId, (client) => client.query(`TRUNCATE ${table}`)),
          ),
        ).resolves.toBe("42501");
      },
    );
  });

  describe("limits in the database itself", () => {
    let runId: string;
    const digest = "a".repeat(64);

    beforeAll(async () => {
      runId = randomUUID();
      await save(a, {
        runId,
        projectId: a.projectId,
        facts: makeFacts({ files: ["x.ts", "y.ts"] }),
      });
    });

    const asA = (sql: string, values: unknown[]) =>
      databaseErrorCode(withTenant(h.app, a.organisationId, (client) => client.query(sql, values)));

    const node = `INSERT INTO graph_nodes (organisation_id, run_id, id, kind, key, attributes) VALUES ($1, $2, $3, $4, $5, $6)`;
    const edge = `INSERT INTO graph_edges (organisation_id, run_id, from_id, to_id, kind, attributes) VALUES ($1, $2, $3, $4, $5, $6)`;
    const run = `INSERT INTO analysis_runs (organisation_id, id, project_id, revision, facts_version, truncated, summary, node_count, edge_count, digest)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

    it.each([
      [
        "a second node of one kind and key",
        node,
        (o: string, r: string) => [o, r, 50, "file", "x.ts", "{}"],
        "23505",
      ],
      [
        "a node id that is used",
        node,
        (o: string, r: string) => [o, r, 0, "file", "new.ts", "{}"],
        "23505",
      ],
      [
        "a node id below zero",
        node,
        (o: string, r: string) => [o, r, -1, "file", "new.ts", "{}"],
        "23514",
      ],
      [
        "a node kind in capitals",
        node,
        (o: string, r: string) => [o, r, 50, "File", "new.ts", "{}"],
        "23514",
      ],
      [
        "a node kind that is too long",
        node,
        (o: string, r: string) => [o, r, 50, "a".repeat(33), "new.ts", "{}"],
        "23514",
      ],
      [
        "a node with an empty key",
        node,
        (o: string, r: string) => [o, r, 50, "file", "", "{}"],
        "23514",
      ],
      [
        "a node with a key over 1,024 characters",
        node,
        (o: string, r: string) => [o, r, 50, "file", "k".repeat(1025), "{}"],
        "23514",
      ],
      [
        "node attributes that are an array",
        node,
        (o: string, r: string) => [o, r, 50, "file", "new.ts", "[]"],
        "23514",
      ],
      [
        "an edge to a node that does not exist",
        edge,
        (o: string, r: string) => [o, r, 0, 77, "imports", "{}"],
        "23503",
      ],
      [
        "an edge from a node that does not exist",
        edge,
        (o: string, r: string) => [o, r, 77, 0, "imports", "{}"],
        "23503",
      ],
      [
        "an edge kind with a digit",
        edge,
        (o: string, r: string) => [o, r, 0, 1, "imports2", "{}"],
        "23514",
      ],
      [
        "edge attributes that are a string",
        edge,
        (o: string, r: string) => [o, r, 0, 1, "imports", '"text"'],
        "23514",
      ],
    ] as const)("refuses %s", async (_name, sql, values, code) => {
      expect(await asA(sql, values(a.organisationId, runId))).toBe(code);
    });

    it("refuses an edge twice", async () => {
      const values = [a.organisationId, runId, 0, 1, "imports", "{}"];
      await withTenant(h.app, a.organisationId, (client) => client.query(edge, values));
      expect(await asA(edge, values)).toBe("23505");
    });

    it.each([
      ["a digest that is not a SHA-256", { digest: "xyz" }],
      ["a revision in capitals", { revision: REVISION.toUpperCase() }],
      ["a facts version of zero", { factsVersion: 0 }],
      [
        "more than sixteen truncation reasons",
        { truncated: Array.from({ length: 17 }, () => "x") },
      ],
      ["a summary that is an array", { summary: "[]" }],
      ["a node count below zero", { nodeCount: -1 }],
      ["an edge count below zero", { edgeCount: -1 }],
    ])("refuses a run with %s", async (_name, change) => {
      const values = {
        revision: null as string | null,
        factsVersion: 1,
        truncated: [] as string[],
        summary: "{}",
        nodeCount: 0,
        edgeCount: 0,
        digest,
        ...change,
      };
      expect(
        await asA(run, [
          a.organisationId,
          randomUUID(),
          a.projectId,
          values.revision,
          values.factsVersion,
          values.truncated,
          values.summary,
          values.nodeCount,
          values.edgeCount,
          values.digest,
        ]),
      ).toBe("23514");
    });
  });

  describe("what the foreign keys of an edge are checked with", () => {
    it("is the primary key of graph_nodes, because no other index of it starts the same way", async () => {
      const result = await h.admin.query<{ name: string; columns: string[] }>(
        `SELECT i.relname AS name,
                array(SELECT a.attname::text FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, n)
                        JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
                       ORDER BY k.n LIMIT 2) AS columns
           FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
          WHERE x.indrelid = 'graph_nodes'::regclass AND NOT x.indisprimary`,
      );
      expect(result.rows.length).toBeGreaterThan(0);
      for (const index of result.rows) {
        expect(Array.isArray(index.columns), index.name).toBe(true);
        expect(index.columns, index.name).not.toEqual(["organisation_id", "run_id"]);
      }
    });

    it("is quick for a run of the largest size, even on a connection that has only stored small runs", async () => {
      // One session, so that what it has planned for the checks while the tables were tiny is
      // still what it uses. A planner that has no statistics yet may choose a scan that walks all
      // the nodes of the run for each edge, and that takes minutes: this failed on the statement
      // timeout (30 seconds) before the unique index of graph_nodes was reordered.
      const pool = h.connect(1);
      for (let index = 0; index < 40; index += 1) {
        await withTenant(pool, a.organisationId, (client) =>
          saveAnalysis(client, {
            runId: randomUUID(),
            projectId: a.projectId,
            facts: makeFacts({
              files: ["a.ts", "b.ts", "c.ts"],
              imports: [
                importOf("a.ts", "./b.js", { type: "internal", path: "b.ts" }),
                importOf("b.ts", "./c.js", { type: "internal", path: "c.ts" }),
              ],
            }),
          }),
        );
      }
      const files = 20_000;
      const paths = Array.from({ length: files }, (_, index) => `big/m${String(index)}.ts`);
      const imports = Array.from({ length: 100_000 }, (_, index) => {
        const from = index % files;
        const to = (from + 1 + Math.floor(index / files) * 997) % files;
        return importOf(`big/m${String(from)}.ts`, "./x.js", {
          type: "internal",
          path: `big/m${String(to)}.ts`,
        });
      });
      const started = performance.now();
      const saved = await withTenant(pool, a.organisationId, (client) =>
        saveAnalysis(client, {
          runId: randomUUID(),
          projectId: a.projectId,
          facts: makeFacts({ files: paths, imports }),
        }),
      );
      expect(saved).toMatchObject({ nodes: files, edges: 100_000 });
      expect((performance.now() - started) / 1000).toBeLessThan(25);
    }, 180_000);
  });

  describe("a run of the largest size that the analysis allows", () => {
    it("is stored whole, in a reasonable time, and is a retry when stored again", async () => {
      const files = 20_000;
      const paths = Array.from({ length: files }, (_, index) => `src/m${String(index)}.ts`);
      const imports = Array.from({ length: 100_000 }, (_, index) => {
        const from = index % files;
        const round = Math.floor(index / files);
        const to = (from + 1 + round * 997) % files;
        return importOf(
          `src/m${String(from)}.ts`,
          "./x.js",
          { type: "internal", path: `src/m${String(to)}.ts` },
          (index % 500) + 1,
        );
      });
      const facts = makeFacts({ files: paths, imports });
      const runId = randomUUID();

      const started = performance.now();
      const saved = await save(a, { runId, projectId: a.projectId, facts });
      const seconds = (performance.now() - started) / 1000;
      expect(saved).toMatchObject({ duplicate: false, nodes: files, edges: 100_000 });
      expect(seconds).toBeLessThan(90);

      const counts = await h.admin.query<{ nodes: number; edges: number }>(
        `SELECT (SELECT count(*) FROM graph_nodes WHERE run_id = $1)::int AS nodes,
                (SELECT count(*) FROM graph_edges WHERE run_id = $1)::int AS edges`,
        [runId],
      );
      expect(counts.rows[0]).toEqual({ nodes: files, edges: 100_000 });

      const again = await save(a, { runId, projectId: a.projectId, facts });
      expect(again).toEqual({ ...saved, duplicate: true });
    }, 180_000);
  });
});
