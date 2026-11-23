import { randomUUID } from "node:crypto";
import type { ApiKeyScope, Principal } from "@codemugs/auth";
import { loadApiConfig } from "@codemugs/configuration";
import {
  GraphError,
  type GraphNode,
  type Neighbour,
  type RunRecord,
} from "@codemugs/system-graph-read";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import type { Authenticator } from "./authentication.js";
import type { GraphService } from "./graph.js";

const opened: BuiltApp[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map(({ app }) => app.close()));
});

const base = { organisationId: randomUUID(), projectId: randomUUID(), apiKeyId: randomUUID() };
const KEYS: Readonly<Record<string, readonly ApiKeyScope[]>> = {
  reader: ["analysis:read"],
  writer: ["analysis:write"],
  events: ["events:write"],
  nothing: [],
};
const authenticator: Authenticator = (token) => {
  const scopes = KEYS[token];
  return Promise.resolve(scopes === undefined ? undefined : { ...base, scopes: [...scopes] });
};
const as = (token: string) => ({ authorization: `Bearer ${token}` });

const RUN_ID = randomUUID();
const RUN: RunRecord = {
  id: RUN_ID,
  projectId: base.projectId,
  revision: "0123456789abcdef0123456789abcdef01234567",
  factsVersion: 1,
  truncated: ["imports"],
  summary: { files: 2 },
  nodeCount: 3,
  edgeCount: 2,
  digest: "a".repeat(64),
  analysedAt: new Date("2026-11-20T10:06:00Z"),
};
const FILE_A: GraphNode = { id: 0, kind: "file", key: "src/a.ts", attributes: { language: "ts" } };
const FILE_B: GraphNode = { id: 1, kind: "file", key: "src/b.ts", attributes: {} };

interface Call {
  method: string;
  principal: Principal;
  argument: unknown[];
}

/** A service that records what it is asked, and answers from the overrides. */
function fake(overrides: Partial<GraphService> = {}) {
  const calls: Call[] = [];
  const record = (method: string, principal: Principal, ...argument: unknown[]) =>
    calls.push({ method, principal, argument });
  const service: GraphService = {
    latest: (who) => {
      record("latest", who);
      return Promise.resolve(RUN);
    },
    run: (who, id) => {
      record("run", who, id);
      return Promise.resolve(RUN);
    },
    nodes: (who, id, options) => {
      record("nodes", who, id, options);
      return Promise.resolve([FILE_A, FILE_B]);
    },
    node: (who, id, kind, key) => {
      record("node", who, id, kind, key);
      return Promise.resolve(FILE_A);
    },
    neighbours: (who, id, nodeId, options) => {
      record("neighbours", who, id, nodeId, options);
      const entry: Neighbour = {
        edge: { kind: "imports", attributes: { lines: [3] } },
        node: FILE_B,
      };
      return Promise.resolve([entry]);
    },
    imports: (who, id, path, options) => {
      record("imports", who, id, path, options);
      return Promise.resolve([{ node: FILE_B, depth: 1 }]);
    },
    ...overrides,
  };
  return { service, calls };
}

async function start(options: { graph?: GraphService; lines?: string[] } = {}): Promise<BuiltApp> {
  const built = await buildApp({
    config: loadApiConfig({
      NODE_ENV: "test",
      LOG_LEVEL: options.lines === undefined ? "silent" : "debug",
    }),
    authenticator,
    ...(options.graph === undefined ? {} : { graph: options.graph }),
    ...(options.lines === undefined
      ? {}
      : { logStream: { write: (line: string) => options.lines?.push(line) } }),
  });
  opened.push(built);
  return built;
}

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

const BASE = `/v1/analyses/${RUN_ID}`;
const ROUTES = [
  "/v1/graph",
  `${BASE}/graph`,
  `${BASE}/nodes`,
  `${BASE}/node?kind=file&key=src/a.ts`,
  `${BASE}/nodes/0/neighbours`,
  `${BASE}/imports?path=src/a.ts&direction=importers`,
] as const;

describe("who may read a graph", () => {
  it.each(ROUTES)("GET %s answers 401 with no key, and calls nothing", async (url) => {
    const { service, calls } = fake();
    const { app } = await start({ graph: service });
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it.each(ROUTES)("GET %s is refused with 403 to a key without analysis:read", async (url) => {
    for (const token of ["writer", "events", "nothing"]) {
      const { service, calls } = fake();
      const { app } = await start({ graph: service });
      const response = await app.inject({ method: "GET", url, headers: as(token) });
      expect(response.statusCode, token).toBe(403);
      expect(response.json<ErrorBody>().error.message).toContain("analysis:read");
      expect(calls, token).toEqual([]);
    }
  });

  it.each(ROUTES)("GET %s answers 503 when reading is not available", async (url) => {
    const { app } = await start();
    const response = await app.inject({ method: "GET", url, headers: as("reader") });
    expect(response.statusCode).toBe(503);
    expect(response.json<ErrorBody>().error.code).toBe("graph_unavailable");
  });

  it.each(ROUTES)("GET %s is for the key's project, and never stored by a cache", async (url) => {
    const { service, calls } = fake();
    const { app } = await start({ graph: service });
    const response = await app.inject({ method: "GET", url, headers: as("reader") });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(calls).toHaveLength(1);
    // The organisation and the project are the credential's.
    expect(calls[0]?.principal).toMatchObject({
      organisationId: base.organisationId,
      projectId: base.projectId,
    });
  });
});

describe("what the routes give", () => {
  it("gives the latest graph, and a run, in numbers and never in content", async () => {
    const { service } = fake();
    const { app } = await start({ graph: service });
    const expected = {
      run: {
        id: RUN_ID,
        projectId: base.projectId,
        revision: RUN.revision,
        factsVersion: 1,
        nodes: 3,
        edges: 2,
        truncated: ["imports"],
        summary: { files: 2 },
        digest: "a".repeat(64),
        analysedAt: "2026-11-20T10:06:00.000Z",
      },
    };
    for (const url of ["/v1/graph", `${BASE}/graph`]) {
      const response = await app.inject({ method: "GET", url, headers: as("reader") });
      expect(response.json()).toEqual(expected);
    }
  });

  it("gives nodes a page at a time, and says where the next page starts only when this one is full", async () => {
    const { service, calls } = fake();
    const { app } = await start({ graph: service });

    const full = await app.inject({
      method: "GET",
      url: `${BASE}/nodes?limit=2&kind=file&after=7`,
      headers: as("reader"),
    });
    expect(full.json()).toEqual({
      nodes: [
        { id: 0, kind: "file", key: "src/a.ts", attributes: { language: "ts" } },
        { id: 1, kind: "file", key: "src/b.ts", attributes: {} },
      ],
      next: 1,
    });
    expect(calls[0]?.argument).toEqual([RUN_ID, { limit: 2, kind: "file", afterId: 7 }]);

    const last = await app.inject({ method: "GET", url: `${BASE}/nodes`, headers: as("reader") });
    expect(last.json<{ next?: number }>().next).toBeUndefined();
    // A page is 100 when the caller does not say.
    expect(calls[1]?.argument).toEqual([RUN_ID, { limit: 100 }]);
  });

  it("gives one node, and what a node is joined to, and what a change to a file reaches", async () => {
    const { service, calls } = fake();
    const { app } = await start({ graph: service });

    const node = await app.inject({
      method: "GET",
      url: `${BASE}/node?kind=file&key=${encodeURIComponent("src/a b.ts")}`,
      headers: as("reader"),
    });
    expect(node.json()).toEqual({ node: FILE_A });
    expect(calls[0]?.argument).toEqual([RUN_ID, "file", "src/a b.ts"]);

    const near = await app.inject({
      method: "GET",
      url: `${BASE}/nodes/4/neighbours?direction=in&edge=imports&limit=5`,
      headers: as("reader"),
    });
    expect(near.json()).toEqual({
      neighbours: [{ edge: { kind: "imports", attributes: { lines: [3] } }, node: FILE_B }],
    });
    expect(calls[1]?.argument).toEqual([RUN_ID, 4, { direction: "in", kind: "imports", limit: 5 }]);

    const reached = await app.inject({
      method: "GET",
      url: `${BASE}/imports?path=src/a.ts&direction=imports&depth=3`,
      headers: as("reader"),
    });
    expect(reached.json()).toEqual({ files: [{ ...FILE_B, depth: 1 }] });
    expect(calls[2]?.argument).toEqual([
      RUN_ID,
      "src/a.ts",
      { direction: "imports", limit: 100, maxDepth: 3 },
    ]);
  });

  it("follows the edges that leave a node unless told otherwise", async () => {
    const { service, calls } = fake();
    const { app } = await start({ graph: service });
    await app.inject({ method: "GET", url: `${BASE}/nodes/0/neighbours`, headers: as("reader") });
    expect(calls[0]?.argument).toEqual([RUN_ID, 0, { direction: "out", limit: 100 }]);
  });
});

describe("what is not found", () => {
  const ABSENT: Array<[string, Partial<GraphService>, string]> = [
    [
      "the graph of a project that was never analysed",
      { latest: () => Promise.resolve(undefined) },
      "/v1/graph",
    ],
    [
      "a run that is not there, or not the key's project's",
      { run: () => Promise.resolve(undefined) },
      `${BASE}/graph`,
    ],
    ["the nodes of such a run", { nodes: () => Promise.resolve(undefined) }, `${BASE}/nodes`],
    [
      "a node of such a run",
      { node: () => Promise.resolve(undefined) },
      `${BASE}/node?kind=file&key=x`,
    ],
    [
      "the edges of such a run",
      { neighbours: () => Promise.resolve(undefined) },
      `${BASE}/nodes/0/neighbours`,
    ],
    [
      "the imports of such a run",
      { imports: () => Promise.resolve(undefined) },
      `${BASE}/imports?path=x&direction=imports`,
    ],
  ];

  it.each(ABSENT)("answers 404 graph_not_found for %s", async (_name, override, url) => {
    const { service } = fake(override);
    const { app } = await start({ graph: service });
    const response = await app.inject({ method: "GET", url, headers: as("reader") });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe("graph_not_found");
  });

  const MISSING: Array<[string, Partial<GraphService>, string]> = [
    [
      "a node that is not in the graph",
      { node: () => Promise.resolve(null) },
      `${BASE}/node?kind=file&key=x`,
    ],
    [
      "the edges of a node that is not there",
      { neighbours: () => Promise.resolve(null) },
      `${BASE}/nodes/9/neighbours`,
    ],
    [
      "the imports of a path that is not a file",
      { imports: () => Promise.resolve(null) },
      `${BASE}/imports?path=x&direction=imports`,
    ],
  ];

  it.each(MISSING)("answers 404 node_not_found for %s", async (_name, override, url) => {
    const { service } = fake(override);
    const { app } = await start({ graph: service });
    const response = await app.inject({ method: "GET", url, headers: as("reader") });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe("node_not_found");
  });
});

describe("what a request may not say", () => {
  const long = "k".repeat(1_025);
  const BAD = [
    // Parameters that the route does not take, which includes naming a project or an organisation.
    `${BASE}/graph?projectId=${randomUUID()}`,
    `/v1/graph?organisationId=${randomUUID()}`,
    `${BASE}/nodes?project=x`,
    `${BASE}/nodes?limit=2&limit=3`,
    // Page sizes.
    `${BASE}/nodes?limit=0`,
    `${BASE}/nodes?limit=1001`,
    `${BASE}/nodes?limit=-1`,
    `${BASE}/nodes?limit=10.5`,
    `${BASE}/nodes?limit=abc`,
    `${BASE}/nodes?limit=`,
    `${BASE}/nodes?limit=%2010`,
    // Where a page starts, and what a node is.
    `${BASE}/nodes?after=-1`,
    `${BASE}/nodes?after=1.5`,
    `${BASE}/nodes?after=2147483648`,
    `${BASE}/nodes?after=9999999999`,
    `${BASE}/nodes?after=007`,
    `${BASE}/nodes?kind=nonsense`,
    `${BASE}/nodes?kind=FILE`,
    `${BASE}/nodes?kind=`,
    // One node.
    `${BASE}/node`,
    `${BASE}/node?kind=file`,
    `${BASE}/node?key=src/a.ts`,
    `${BASE}/node?kind=nonsense&key=src/a.ts`,
    `${BASE}/node?kind=file&key=`,
    `${BASE}/node?kind=file&key=a%00b`,
    `${BASE}/node?kind=file&key=${long}`,
    // Edges.
    `${BASE}/nodes/-1/neighbours`,
    `${BASE}/nodes/abc/neighbours`,
    `${BASE}/nodes/1.5/neighbours`,
    `${BASE}/nodes/2147483648/neighbours`,
    `${BASE}/nodes/1/neighbours?direction=sideways`,
    `${BASE}/nodes/1/neighbours?direction=`,
    `${BASE}/nodes/1/neighbours?edge=nonsense`,
    `${BASE}/nodes/1/neighbours?limit=0`,
    // Imports.
    `${BASE}/imports`,
    `${BASE}/imports?path=src/a.ts`,
    `${BASE}/imports?direction=imports`,
    `${BASE}/imports?path=src/a.ts&direction=both`,
    `${BASE}/imports?path=&direction=imports`,
    `${BASE}/imports?path=a%00b&direction=imports`,
    `${BASE}/imports?path=${long}&direction=imports`,
    `${BASE}/imports?path=src/a.ts&direction=imports&depth=0`,
    `${BASE}/imports?path=src/a.ts&direction=imports&depth=-1`,
    `${BASE}/imports?path=src/a.ts&direction=imports&depth=100`,
    `${BASE}/imports?path=src/a.ts&direction=imports&depth=x`,
    `${BASE}/imports?path=src/a.ts&direction=imports&limit=1001`,
  ];

  it.each(BAD)("refuses %s with 400, and asks nothing", async (url) => {
    const { service, calls } = fake();
    const { app } = await start({ graph: service });
    const response = await app.inject({ method: "GET", url, headers: as("reader") });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe("invalid_input");
    expect(calls).toEqual([]);
  });

  it("allows the largest page, the largest node number and the longest key", async () => {
    const { service, calls } = fake();
    const { app } = await start({ graph: service });
    for (const url of [
      `${BASE}/nodes?limit=1000&after=999999999`,
      `${BASE}/nodes/999999999/neighbours?limit=1000`,
      `${BASE}/node?kind=file&key=${"k".repeat(1_024)}`,
      `${BASE}/imports?path=src/a.ts&direction=importers&depth=50&limit=1000`,
    ]) {
      const response = await app.inject({ method: "GET", url, headers: as("reader") });
      expect(response.statusCode, url).toBe(200);
    }
    expect(calls).toHaveLength(4);
  });

  it("answers 400 for an id that the library refuses, and says nothing of what was sent", async () => {
    const { service } = fake({ run: () => Promise.reject(new GraphError("invalid_input")) });
    const { app } = await start({ graph: service });
    const response = await app.inject({
      method: "GET",
      url: "/v1/analyses/not-a-uuid%27%3B--/graph",
      headers: as("reader"),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe("invalid_input");
    expect(response.body).not.toContain("not-a-uuid");
  });
});

describe("what goes wrong inside", () => {
  it("answers 500 and exposes nothing when the service fails for another reason", async () => {
    const lines: string[] = [];
    const { service } = fake({
      nodes: () =>
        Promise.reject(new Error('connect ECONNREFUSED 10.1.2.3:5432 password "hunter2"')),
    });
    const { app } = await start({ graph: service, lines });
    const response = await app.inject({
      method: "GET",
      url: `${BASE}/nodes`,
      headers: as("reader"),
    });
    expect(response.statusCode).toBe(500);
    expect(response.json<ErrorBody>().error.code).toBe("internal_error");
    expect(response.body).not.toContain("10.1.2.3");
    expect(response.body).not.toContain("hunter2");
    expect(lines.join("\n")).toContain("unhandled error");
  });

  it("does not turn another kind of graph error into something the caller can read", async () => {
    // `run_conflict` and the like belong to storing a graph and cannot come from a read; if one did,
    // it is a fault of ours and not an answer.
    const { service } = fake({ run: () => Promise.reject(new GraphError("run_conflict")) });
    const { app } = await start({ graph: service });
    const response = await app.inject({
      method: "GET",
      url: `${BASE}/graph`,
      headers: as("reader"),
    });
    expect(response.statusCode).toBe(500);
    expect(response.json<ErrorBody>().error.code).toBe("internal_error");
  });
});
