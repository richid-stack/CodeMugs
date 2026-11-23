import { randomUUID } from "node:crypto";
import type { Principal } from "@codemugs/auth";
import type { Pool } from "@codemugs/storage";
import { describe, expect, it } from "vitest";
import { createGraphService, type GraphService } from "./graph.js";

const principal: Principal = {
  organisationId: randomUUID(),
  projectId: randomUUID(),
  apiKeyId: randomUUID(),
  scopes: ["analysis:read"],
};
const RUN = randomUUID();

/** A pool whose connections record every statement, and find a run of the project that `owner` says. */
function recording(owner: string | null, nodes: Array<{ id: number }> = []) {
  const statements: string[] = [];
  const client = {
    on: () => client,
    removeListener: () => client,
    release: () => undefined,
    query: (text: string) => {
      statements.push(text);
      if (/FROM analysis_runs/.test(text) && /\bid = \$2\b/.test(text) && owner !== null) {
        return Promise.resolve({
          rows: [
            {
              id: RUN,
              project_id: owner,
              revision: null,
              facts_version: 1,
              truncated: [],
              summary: {},
              node_count: 0,
              edge_count: 0,
              digest: "c".repeat(64),
              analysed_at: new Date(),
            },
          ],
        });
      }
      if (/FROM graph_nodes/.test(text) && /\bid > \$4\b/.test(text)) {
        return Promise.resolve({
          rows: nodes.map((node) => ({ id: node.id, kind: "file", key: "a.ts", attributes: {} })),
        });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
  return { service: createGraphService(pool), statements };
}

type Call = (service: GraphService) => Promise<unknown>;
const CALLS: Array<[string, Call]> = [
  ["latest", (s) => s.latest(principal)],
  ["run", (s) => s.run(principal, RUN)],
  ["nodes", (s) => s.nodes(principal, RUN, { limit: 10 })],
  ["node", (s) => s.node(principal, RUN, "file", "a.ts")],
  ["neighbours", (s) => s.neighbours(principal, RUN, 0, { direction: "out", limit: 10 })],
  ["imports", (s) => s.imports(principal, RUN, "a.ts", { direction: "imports", limit: 10 })],
];

describe("every read of a graph", () => {
  it.each(CALLS)("%s is one read-only transaction, and writes nothing", async (_name, call) => {
    const { service, statements } = recording(principal.projectId);
    await call(service);
    const begins = statements.filter((text) => text.startsWith("BEGIN"));
    expect(begins).toEqual(["BEGIN READ ONLY"]);
    expect(
      statements.some((text) =>
        /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|DROP|ALTER)\b/i.test(text),
      ),
    ).toBe(false);
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it.each(CALLS.filter(([name]) => name !== "latest"))(
    "%s reads nothing of a run that is another project's",
    async (_name, call) => {
      const { service, statements } = recording(randomUUID());
      expect(await call(service)).toBeUndefined();
      expect(statements.some((text) => /graph_nodes|graph_edges/.test(text))).toBe(false);
    },
  );

  it.each(CALLS.filter(([name]) => name !== "latest"))(
    "%s reads nothing of a run that is not there",
    async (_name, call) => {
      const { service, statements } = recording(null);
      expect(await call(service)).toBeUndefined();
      expect(statements.some((text) => /graph_nodes|graph_edges/.test(text))).toBe(false);
    },
  );
});

describe("the edges of a node", () => {
  it("are not read for a node that is not there, even when another node follows it", async () => {
    // Node 3 is missing and the next node that exists is 5: the first node after 2 is not node 3.
    const { service, statements } = recording(principal.projectId, [{ id: 5 }]);
    expect(await service.neighbours(principal, RUN, 3, { direction: "out", limit: 10 })).toBeNull();
    expect(statements.some((text) => /graph_edges/.test(text))).toBe(false);
  });

  it("are read for a node that is there", async () => {
    const { service, statements } = recording(principal.projectId, [{ id: 3 }]);
    expect(await service.neighbours(principal, RUN, 3, { direction: "out", limit: 10 })).toEqual(
      [],
    );
    expect(statements.some((text) => /graph_edges/.test(text))).toBe(true);
  });
});
