import { randomUUID } from "node:crypto";
import type { ApiKeyScope, Principal } from "@codemugs/auth";
import { loadApiConfig } from "@codemugs/configuration";
import {
  RepositoryAnalysisError,
  type AnalysisState,
  type RepositoryAnalysisErrorCode,
  type RepositoryConnection,
} from "@codemugs/repository-analysis";
import { afterEach, describe, expect, it } from "vitest";
import type { AnalysisService } from "./analysis.js";
import { buildApp, type BuiltApp } from "./app.js";
import type { Authenticator } from "./authentication.js";

const opened: BuiltApp[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map(({ app }) => app.close()));
});

const base = { organisationId: randomUUID(), projectId: randomUUID(), apiKeyId: randomUUID() };
const KEYS: Readonly<Record<string, readonly ApiKeyScope[]>> = {
  writer: ["analysis:write"],
  reader: ["analysis:read"],
  both: ["analysis:write", "analysis:read"],
  events: ["events:write"],
  nothing: [],
};
const authenticator: Authenticator = (token) => {
  const scopes = KEYS[token];
  return Promise.resolve(scopes === undefined ? undefined : { ...base, scopes: [...scopes] });
};
const principal = (token: keyof typeof KEYS): Principal => ({
  ...base,
  scopes: [...(KEYS[token] ?? [])],
});
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const json = (token: string) => ({ ...as(token), "content-type": "application/json" });

const CONNECTION: RepositoryConnection = {
  connectionId: randomUUID(),
  projectId: base.projectId,
  installationId: 42,
  owner: "acme",
  name: "shop",
  connectedAt: new Date("2026-11-20T10:00:00Z"),
};
const ANALYSIS_ID = randomUUID();
const QUEUED: AnalysisState = {
  requestId: ANALYSIS_ID,
  projectId: base.projectId,
  ref: "main",
  requestedAt: new Date("2026-11-20T10:05:00Z"),
  status: "queued",
  attempts: 0,
};
const FAILED: AnalysisState = {
  ...QUEUED,
  status: "failed",
  attempts: 3,
  failureCode: "repository_too_large",
};
const SUCCEEDED: AnalysisState = {
  ...QUEUED,
  status: "succeeded",
  attempts: 1,
  run: {
    revision: "0123456789abcdef0123456789abcdef01234567",
    nodes: 12,
    edges: 20,
    truncated: [],
    analysedAt: new Date("2026-11-20T10:06:00Z"),
  },
};

interface Call {
  method: string;
  principal: Principal;
  argument?: unknown;
}

/** A service that records what it is asked and answers from the overrides. */
function fake(overrides: Partial<AnalysisService> = {}) {
  const calls: Call[] = [];
  const service: AnalysisService = {
    connect: (who, input) => {
      calls.push({ method: "connect", principal: who, argument: input });
      return Promise.resolve(CONNECTION);
    },
    repository: (who) => {
      calls.push({ method: "repository", principal: who });
      return Promise.resolve(CONNECTION);
    },
    request: (who, input) => {
      calls.push({ method: "request", principal: who, argument: input });
      return Promise.resolve({ id: ANALYSIS_ID });
    },
    analysis: (who, id) => {
      calls.push({ method: "analysis", principal: who, argument: id });
      return Promise.resolve(QUEUED);
    },
    analyses: (who, options) => {
      calls.push({ method: "analyses", principal: who, argument: options });
      return Promise.resolve([QUEUED]);
    },
    ...overrides,
  };
  return { service, calls };
}

async function start(
  options: { analysis?: AnalysisService; lines?: string[] } = {},
): Promise<BuiltApp> {
  const built = await buildApp({
    config: loadApiConfig({
      NODE_ENV: "test",
      LOG_LEVEL: options.lines === undefined ? "silent" : "debug",
    }),
    authenticator,
    ...(options.analysis === undefined ? {} : { analysis: options.analysis }),
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

const CONNECT_BODY = { installationId: 42, owner: "acme", name: "shop" };

describe("the scope that each route needs", () => {
  // [method, url, a body for a route that takes one, the scope that the route needs]
  const ROUTES = [
    ["POST", "/v1/repository", CONNECT_BODY, "analysis:write"],
    ["GET", "/v1/repository", undefined, "analysis:read"],
    ["POST", "/v1/analyses", { ref: "main" }, "analysis:write"],
    ["GET", "/v1/analyses", undefined, "analysis:read"],
    ["GET", `/v1/analyses/${ANALYSIS_ID}`, undefined, "analysis:read"],
  ] as const;

  it.each(ROUTES)(
    "%s %s is refused with 403 to a key that lacks %s, and nothing is called",
    async (method, url, payload, needs) => {
      for (const token of Object.keys(KEYS)) {
        if (KEYS[token]?.includes(needs)) continue;
        const { service, calls } = fake();
        const { app } = await start({ analysis: service });

        const response = await app.inject({
          method,
          url,
          headers: json(token),
          ...(payload === undefined ? {} : { payload }),
        });

        expect(response.statusCode, `key: ${token}`).toBe(403);
        expect(response.json<ErrorBody>().error.code).toBe("forbidden");
        expect(response.json<ErrorBody>().error.message).toContain(needs);
        expect(calls, `key: ${token}`).toEqual([]);
      }
    },
  );

  it.each(ROUTES)("%s %s is refused with 401 without a key", async (method, url, payload) => {
    const { service, calls } = fake();
    const { app } = await start({ analysis: service });
    const response = await app.inject({
      method,
      url,
      headers: { "content-type": "application/json" },
      ...(payload === undefined ? {} : { payload }),
    });
    expect(response.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it.each(ROUTES)(
    "%s %s answers 503 for a key that may, when there is no service",
    async (method, url, payload, needs) => {
      const { app } = await start();
      const response = await app.inject({
        method,
        url,
        headers: json(needs === "analysis:write" ? "writer" : "reader"),
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json<ErrorBody>().error.code).toBe("analysis_unavailable");
    },
  );

  it("does not look at a body that a key may not send", async () => {
    const { service, calls } = fake();
    const { app } = await start({ analysis: service });
    const response = await app.inject({
      method: "POST",
      url: "/v1/repository",
      headers: json("reader"),
      payload: "{ this is not json",
    });
    // Refused for the scope, before the body is parsed: not a 400 for the JSON.
    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("POST /v1/repository", () => {
  it("connects the project of the key and answers 201 with what it is", async () => {
    const { service, calls } = fake();
    const { app } = await start({ analysis: service });

    const response = await app.inject({
      method: "POST",
      url: "/v1/repository",
      headers: json("writer"),
      payload: CONNECT_BODY,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      connectionId: CONNECTION.connectionId,
      projectId: base.projectId,
      installationId: 42,
      owner: "acme",
      name: "shop",
      connectedAt: "2026-11-20T10:00:00.000Z",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(calls).toEqual([
      { method: "connect", principal: principal("writer"), argument: CONNECT_BODY },
    ]);
  });

  it.each([
    ["no body", undefined],
    ["a list", []],
    ["null", null],
    ["a string", "acme/shop"],
    ["no installation", { owner: "acme", name: "shop" }],
    ["no owner", { installationId: 42, name: "shop" }],
    ["no name", { installationId: 42, owner: "acme" }],
    ["an installation that is text", { ...CONNECT_BODY, installationId: "42" }],
    ["an owner that is a number", { ...CONNECT_BODY, owner: 7 }],
    ["a name that is null", { ...CONNECT_BODY, name: null }],
  ])("refuses %s with 400 and calls nothing", async (_label, payload) => {
    const { service, calls } = fake();
    const { app } = await start({ analysis: service });
    const response = await app.inject({
      method: "POST",
      url: "/v1/repository",
      headers: json("writer"),
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    expect(response.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it.each([
    ["a project", { projectId: randomUUID() }],
    ["an organisation", { organisationId: randomUUID() }],
    ["any other field", { token: "x" }],
  ])(
    "refuses a body that names %s, instead of ignoring it, and calls nothing",
    async (_label, extra) => {
      const { service, calls } = fake();
      const { app } = await start({ analysis: service });
      const response = await app.inject({
        method: "POST",
        url: "/v1/repository",
        headers: json("writer"),
        payload: { ...CONNECT_BODY, ...extra },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe("invalid_input");
      // What it sent does not come back.
      expect(response.body).not.toContain(Object.values(extra)[0] as string);
      expect(calls).toEqual([]);
    },
  );

  it("takes the project from the key and nothing in the query string or the headers", async () => {
    const { service, calls } = fake();
    const { app } = await start({ analysis: service });
    const other = randomUUID();
    await app.inject({
      method: "POST",
      url: `/v1/repository?projectId=${other}&organisationId=${other}`,
      headers: { ...json("writer"), "x-project-id": other, "x-organisation-id": other },
      payload: CONNECT_BODY,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.principal).toEqual(principal("writer"));
  });

  it.each<[RepositoryAnalysisErrorCode, number]>([
    ["invalid_input", 400],
    ["project_not_found", 404],
    ["installation_not_found", 404],
    ["connection_exists", 409],
    ["connection_not_found", 404],
  ])("answers a %s of the library with %i, in the words of the API", async (code, status) => {
    const { service } = fake({
      connect: () => Promise.reject(new RepositoryAnalysisError(code)),
    });
    const { app } = await start({ analysis: service });
    const response = await app.inject({
      method: "POST",
      url: "/v1/repository",
      headers: json("writer"),
      payload: CONNECT_BODY,
    });
    expect(response.statusCode).toBe(status);
    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe(code);
    expect(error.requestId).toBeTruthy();
    // Nothing that the caller sent is said back.
    expect(error.message).not.toContain("acme");
    expect(error.message).not.toContain("shop");
  });

  it("answers 500 and exposes nothing when the service fails for another reason", async () => {
    const lines: string[] = [];
    const { service } = fake({
      connect: () =>
        Promise.reject(new Error('connect ECONNREFUSED 10.1.2.3:5432 password "hunter2"')),
    });
    const { app } = await start({ analysis: service, lines });
    const response = await app.inject({
      method: "POST",
      url: "/v1/repository",
      headers: json("writer"),
      payload: CONNECT_BODY,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json<ErrorBody>().error.code).toBe("internal_error");
    expect(response.body).not.toContain("10.1.2.3");
    expect(response.body).not.toContain("hunter2");
    expect(lines.join("\n")).toContain("unhandled error");
  });
});

describe("GET /v1/repository", () => {
  it("gives the repository of the key's project", async () => {
    const { service, calls } = fake();
    const { app } = await start({ analysis: service });
    const response = await app.inject({
      method: "GET",
      url: "/v1/repository",
      headers: as("reader"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ owner: "acme", name: "shop", installationId: 42 });
    expect(calls).toEqual([{ method: "repository", principal: principal("reader") }]);
  });

  it("answers 404 when the project is not connected", async () => {
    const { service } = fake({ repository: () => Promise.resolve(undefined) });
    const { app } = await start({ analysis: service });
    const response = await app.inject({
      method: "GET",
      url: "/v1/repository",
      headers: as("reader"),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe("connection_not_found");
  });
});

describe("POST /v1/analyses", () => {
  it("asks for the analysis and answers 202 with where to look", async () => {
    const { service, calls } = fake();
    const { app } = await start({ analysis: service });
    const response = await app.inject({
      method: "POST",
      url: "/v1/analyses",
      headers: json("writer"),
      payload: { ref: "release/1.2" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ id: ANALYSIS_ID, status: "queued" });
    expect(response.headers.location).toBe(`/v1/analyses/${ANALYSIS_ID}`);
    expect(calls).toEqual([
      { method: "request", principal: principal("writer"), argument: { ref: "release/1.2" } },
    ]);
  });

  it.each([
    ["no body", undefined],
    ["a list", []],
    ["no ref", {}],
    ["a ref that is a number", { ref: 7 }],
    ["a ref that is null", { ref: null }],
    ["a project of its own choosing", { ref: "main", projectId: randomUUID() }],
  ])("refuses %s with 400 and calls nothing", async (_label, payload) => {
    const { service, calls } = fake();
    const { app } = await start({ analysis: service });
    const response = await app.inject({
      method: "POST",
      url: "/v1/analyses",
      headers: json("writer"),
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    expect(response.statusCode).toBe(400);
    // An empty body is refused by the framework before the route sees it.
    expect(response.json<ErrorBody>().error.code).toMatch(/^invalid_(input|json)$/);
    expect(calls).toEqual([]);
  });

  it("answers 404 when the project is not connected, and 400 for a ref the library refuses", async () => {
    for (const [code, status] of [
      ["connection_not_found", 404],
      ["invalid_input", 400],
    ] as const) {
      const { service } = fake({
        request: () => Promise.reject(new RepositoryAnalysisError(code)),
      });
      const { app } = await start({ analysis: service });
      const response = await app.inject({
        method: "POST",
        url: "/v1/analyses",
        headers: json("writer"),
        payload: { ref: "main" },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json<ErrorBody>().error.code).toBe(code);
    }
  });
});

describe("GET /v1/analyses", () => {
  it("lists the analyses of the key's project, as the API shows them", async () => {
    const { service } = fake({
      analyses: () => Promise.resolve([SUCCEEDED, FAILED, QUEUED]),
    });
    const { app } = await start({ analysis: service });
    const response = await app.inject({
      method: "GET",
      url: "/v1/analyses",
      headers: as("reader"),
    });
    expect(response.statusCode).toBe(200);
    const { analyses } = response.json<{ analyses: Array<Record<string, unknown>> }>();
    expect(analyses.map((a) => a.status)).toEqual(["succeeded", "failed", "queued"]);
    // The analysis is `id`, not `requestId`, and a failure is a code and a run is its counts.
    expect(analyses[0]).toEqual({
      id: ANALYSIS_ID,
      projectId: base.projectId,
      ref: "main",
      requestedAt: "2026-11-20T10:05:00.000Z",
      status: "succeeded",
      attempts: 1,
      run: {
        revision: "0123456789abcdef0123456789abcdef01234567",
        nodes: 12,
        edges: 20,
        truncated: [],
        analysedAt: "2026-11-20T10:06:00.000Z",
      },
    });
    expect(analyses[1]).toMatchObject({ status: "failed", failureCode: "repository_too_large" });
    expect(analyses[1]).not.toHaveProperty("run");
    expect(analyses[2]).not.toHaveProperty("failureCode");
  });

  it("lists for the project of the key, with no page size unless one is asked for", async () => {
    const { service, calls } = fake();
    const { app } = await start({ analysis: service });
    await app.inject({ method: "GET", url: "/v1/analyses", headers: as("reader") });
    expect(calls).toEqual([{ method: "analyses", principal: principal("reader"), argument: {} }]);
  });

  it("passes a page size on, and refuses one that is not a plain number", async () => {
    const { service, calls } = fake();
    const { app } = await start({ analysis: service });
    const get = (query: string) =>
      app.inject({ method: "GET", url: `/v1/analyses${query}`, headers: as("reader") });

    expect((await get("?limit=5")).statusCode).toBe(200);
    expect(calls.at(-1)?.argument).toEqual({ limit: 5 });

    for (const bad of ["0", "-1", "abc", "1e2", "1.5", " 5", "05", "", "12345", "5&limit=6"]) {
      const before = calls.length;
      const response = await get(`?limit=${encodeURIComponent(bad)}`);
      expect(response.statusCode, `limit=${bad}`).toBe(400);
      expect(calls.length, `limit=${bad}`).toBe(before);
    }
    // A page size that the query string gives twice is an array, and refused.
    const twice = await get("?limit=5&limit=6");
    expect(twice.statusCode).toBe(400);
  });

  it("passes on a page size that the library then refuses, as a 400", async () => {
    const { service } = fake({
      analyses: () => Promise.reject(new RepositoryAnalysisError("invalid_input")),
    });
    const { app } = await start({ analysis: service });
    const response = await app.inject({
      method: "GET",
      url: "/v1/analyses?limit=9999",
      headers: as("reader"),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /v1/analyses/:id", () => {
  it("says how the analysis is going", async () => {
    const { service } = fake({ analysis: () => Promise.resolve(FAILED) });
    const { app } = await start({ analysis: service });
    const response = await app.inject({
      method: "GET",
      url: `/v1/analyses/${ANALYSIS_ID}`,
      headers: as("reader"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: ANALYSIS_ID,
      status: "failed",
      attempts: 3,
      failureCode: "repository_too_large",
    });
  });

  it("asks for the id of the path, for the caller of the key", async () => {
    const { service, calls } = fake();
    const { app } = await start({ analysis: service });
    await app.inject({ method: "GET", url: `/v1/analyses/${ANALYSIS_ID}`, headers: as("reader") });
    expect(calls).toEqual([
      { method: "analysis", principal: principal("reader"), argument: ANALYSIS_ID },
    ]);
  });

  it("answers 404 when there is no such analysis for this key, without saying why", async () => {
    const { service } = fake({ analysis: () => Promise.resolve(undefined) });
    const { app } = await start({ analysis: service });
    const response = await app.inject({
      method: "GET",
      url: `/v1/analyses/${randomUUID()}`,
      headers: as("reader"),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe("analysis_not_found");
  });

  it("answers 400 for an id that is not one, as the library says", async () => {
    const { service } = fake({
      analysis: () => Promise.reject(new RepositoryAnalysisError("invalid_input")),
    });
    const { app } = await start({ analysis: service });
    const response = await app.inject({
      method: "GET",
      url: "/v1/analyses/not-an-id",
      headers: as("reader"),
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("not-an-id");
  });
});
