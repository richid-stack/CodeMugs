import { randomUUID } from "node:crypto";
import type { Principal } from "@codemugs/auth";
import { loadApiConfig } from "@codemugs/configuration";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import type { Authenticator } from "./authentication.js";

const quiet = loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const opened: BuiltApp[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map(({ app }) => app.close()));
});

const principal: Principal = {
  organisationId: randomUUID(),
  projectId: randomUUID(),
  apiKeyId: randomUUID(),
};

const VALID_TOKEN = "valid-token-for-tests";

/** An authenticator that accepts one token, and records every token it was asked about. */
function fakeAuthenticator() {
  const asked: string[] = [];
  const authenticator: Authenticator = (token) => {
    asked.push(token);
    return Promise.resolve(token === VALID_TOKEN ? principal : undefined);
  };
  return { authenticator, asked };
}

async function create(options: Parameters<typeof buildApp>[0]): Promise<BuiltApp> {
  const built = await buildApp(options);
  opened.push(built);
  return built;
}

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

describe("GET /v1/whoami", () => {
  it("returns who the credential belongs to, and nothing cacheable", async () => {
    const { authenticator, asked } = fakeAuthenticator();
    const { app } = await create({ config: quiet, authenticator });

    const response = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(principal);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toBeDefined();
    expect(asked).toEqual([VALID_TOKEN]);
  });

  it("accepts the scheme in any letter case", async () => {
    const { authenticator } = fakeAuthenticator();
    const { app } = await create({ config: quiet, authenticator });
    const response = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: `bearer ${VALID_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("a request without a valid credential", () => {
  const cases: Array<[string, Record<string, string>]> = [
    ["no Authorization header", {}],
    ["a different scheme", { authorization: `Basic ${VALID_TOKEN}` }],
    ["a scheme with no token", { authorization: "Bearer" }],
    ["two tokens", { authorization: `Bearer ${VALID_TOKEN} ${VALID_TOKEN}` }],
    ["an unknown token", { authorization: "Bearer not-the-token" }],
    ["the right token in the wrong header", { "x-api-key": VALID_TOKEN }],
    ["the right token in the query-style header", { "x-auth-token": VALID_TOKEN }],
  ];

  it.each(cases)("gets one 401 for %s", async (_label, headers) => {
    const { authenticator } = fakeAuthenticator();
    const { app } = await create({ config: quiet, authenticator });

    const response = await app.inject({ method: "GET", url: "/v1/whoami", headers });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe('Bearer realm="codemugs"');
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<ErrorBody>();
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.requestId).toBe(response.headers["x-request-id"]);
  });

  it("cannot tell the caller why: every failure has the same body", async () => {
    const { authenticator } = fakeAuthenticator();
    const { app } = await create({ config: quiet, authenticator });

    const bodies = new Set<string>();
    for (const [, headers] of cases) {
      const response = await app.inject({ method: "GET", url: "/v1/whoami", headers });
      const { error } = response.json<ErrorBody>();
      bodies.add(JSON.stringify({ code: error.code, message: error.message }));
    }
    expect(bodies.size).toBe(1);
  });

  it("does not ask the authenticator about a header that cannot hold a token", async () => {
    const { authenticator, asked } = fakeAuthenticator();
    const { app } = await create({ config: quiet, authenticator });
    for (const authorization of [undefined, "Basic abc", "Bearer", "Bearer a b"]) {
      await app.inject({
        method: "GET",
        url: "/v1/whoami",
        headers: authorization === undefined ? {} : { authorization },
      });
    }
    expect(asked).toEqual([]);
  });

  it("never repeats the presented token in the response", async () => {
    const { authenticator } = fakeAuthenticator();
    const { app } = await create({ config: quiet, authenticator });
    const token = "secret-looking-token-that-must-not-be-echoed";
    const response = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(token);
    expect(JSON.stringify(response.headers)).not.toContain(token);
  });
});

describe("when the authenticator cannot decide", () => {
  it("answers with a generic 500, not a 401, and leaks nothing", async () => {
    const authenticator: Authenticator = () =>
      Promise.reject(new Error("password=hunter2 connection to db.internal refused"));
    const { app } = await create({ config: quiet, authenticator });

    const response = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json<ErrorBody>().error.code).toBe("internal_error");
    expect(response.body).not.toContain("hunter2");
    expect(response.body).not.toContain("db.internal");
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });
});

describe("when no authenticator is configured", () => {
  it("refuses every /v1 request with 503, even one with a credential", async () => {
    const { app } = await create({ config: quiet });
    for (const headers of [{}, { authorization: `Bearer ${VALID_TOKEN}` }]) {
      const response = await app.inject({ method: "GET", url: "/v1/whoami", headers });
      expect(response.statusCode).toBe(503);
      expect(response.json<ErrorBody>().error.code).toBe("authentication_unavailable");
    }
  });
});

describe("tenant identity", () => {
  it("comes from the credential and from nothing else in the request", async () => {
    const { authenticator, asked } = fakeAuthenticator();
    const { app } = await create({ config: quiet, authenticator });
    const other = randomUUID();

    const response = await app.inject({
      method: "GET",
      url: `/v1/whoami?organisationId=${other}&projectId=${other}&tenant=${other}&organization_id=${other}`,
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        "x-organisation-id": other,
        "x-project-id": other,
        "x-tenant-id": other,
        "x-api-key": "another-key-entirely",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(principal);
    expect(response.body).not.toContain(other);
    // Only the Authorization header's token was ever considered.
    expect(asked).toEqual([VALID_TOKEN]);
  });
});

describe("what is public", () => {
  it("keeps liveness and readiness open without a credential", async () => {
    const { authenticator } = fakeAuthenticator();
    const { app } = await create({ config: quiet, authenticator });
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });

  it("answers an unknown route with the usual 404, not a credential error", async () => {
    const { authenticator } = fakeAuthenticator();
    const { app } = await create({ config: quiet, authenticator });
    const response = await app.inject({ method: "GET", url: "/v1/nothing-here" });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe("not_found");
  });

  it("protects every route under /v1, including any added later", async () => {
    // Reads the app's own route table, so a new /v1 route is covered automatically, and a /v1
    // route registered outside the authenticated scope fails here.
    const { authenticator } = fakeAuthenticator();
    const { app } = await create({ config: quiet, authenticator });
    await app.ready();

    // printRoutes draws a tree ("├── /v1/whoami (GET, HEAD)"); with commonPrefix off every line
    // still holds one full path, so strip the drawing characters and read it.
    const routes = app
      .printRoutes({ commonPrefix: false })
      .split("\n")
      .map((line) => /^(\/\S*) \(([^)]+)\)$/.exec(line.replace(/^[\s│├└─]+/u, "")))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ url: match[1] ?? "", methods: (match[2] ?? "").split(", ") }))
      .filter((route) => route.url.startsWith("/v1"));

    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      for (const method of route.methods) {
        const response = await app.inject({
          method: method as "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE",
          url: route.url,
        });
        expect(response.statusCode, `${method} ${route.url}`).toBe(401);
      }
    }
  });
});

describe("logging", () => {
  it("never writes an API key to the log, and records who made an authenticated request", async () => {
    const lines: string[] = [];
    const { authenticator } = fakeAuthenticator();
    const { app } = await create({
      config: loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "debug" }),
      authenticator,
      logStream: { write: (line) => lines.push(line) },
    });

    const wrong = "wrong-secret-looking-token-for-the-log-test";
    await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: `Bearer ${wrong}`, "x-api-key": wrong },
    });
    await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    const log = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(log).not.toContain(wrong);
    expect(log).not.toContain(VALID_TOKEN);
    expect(log).toContain("authentication failed");
    // The authenticated request's completion line carries the caller's identifiers.
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const completed = entries.filter(
      (entry) => entry["msg"] === "request completed" && entry["organisationId"] !== undefined,
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      organisationId: principal.organisationId,
      projectId: principal.projectId,
      apiKeyId: principal.apiKeyId,
    });
    // The rejected request has no caller to name.
    const rejected = entries.filter(
      (entry) => entry["msg"] === "request completed" && entry["organisationId"] === undefined,
    );
    expect(rejected).toHaveLength(1);
  });
});
