import { randomUUID } from "node:crypto";
import type { Principal } from "@codemugs/auth";
import { loadApiConfig } from "@codemugs/configuration";
import type { IngestOutcome, IngestScope } from "@codemugs/ingestion";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import type { Authenticator } from "./authentication.js";
import type { EventIngester } from "./ingestion.js";

const opened: BuiltApp[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map(({ app }) => app.close()));
});

const principal: Principal = {
  organisationId: randomUUID(),
  projectId: randomUUID(),
  apiKeyId: randomUUID(),
};
const TOKEN = "valid-token-for-tests";
const authenticator: Authenticator = (token) =>
  Promise.resolve(token === TOKEN ? principal : undefined);

const ACCEPTED: IngestOutcome = {
  ok: true,
  result: {
    accepted: 1,
    duplicates: 1,
    rejected: 1,
    results: [
      { index: 0, eventId: "e0", status: "accepted" },
      { index: 1, eventId: "e1", status: "duplicate" },
      { index: 2, status: "rejected", reason: "invalid_event", field: "type" },
    ],
  },
};

interface Call {
  scope: IngestScope;
  body: unknown;
}

function recorder(outcome: IngestOutcome = ACCEPTED) {
  const calls: Call[] = [];
  const ingester: EventIngester = (scope, body) => {
    calls.push({ scope, body });
    return Promise.resolve(outcome);
  };
  return { ingester, calls };
}

async function start(options: {
  ingester?: EventIngester;
  bodyLimit?: string;
  logLevel?: string;
  lines?: string[];
}): Promise<BuiltApp> {
  const built = await buildApp({
    config: loadApiConfig({
      NODE_ENV: "test",
      LOG_LEVEL: options.logLevel ?? "silent",
      ...(options.bodyLimit === undefined ? {} : { BODY_LIMIT_BYTES: options.bodyLimit }),
    }),
    authenticator,
    ...(options.ingester === undefined ? {} : { ingester: options.ingester }),
    ...(options.lines === undefined
      ? {}
      : { logStream: { write: (line: string) => options.lines?.push(line) } }),
  });
  opened.push(built);
  return built;
}

const json = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

describe("POST /v1/events", () => {
  it("answers 202 with a result for every event, and nothing cacheable", async () => {
    const { ingester } = recorder();
    const { app } = await start({ ingester });

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: json,
      payload: { events: [{}, {}, {}] },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      accepted: 1,
      duplicates: 1,
      rejected: 1,
      results: (ACCEPTED as { result: { results: unknown[] } }).result.results,
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-type"]).toMatch(/application\/json/);
  });

  it("records under the organisation, project and key of the credential, and the body as sent", async () => {
    const { ingester, calls } = recorder();
    const { app } = await start({ ingester });
    const body = { events: [{ eventId: "x" }] };

    await app.inject({ method: "POST", url: "/v1/events", headers: json, payload: body });

    expect(calls).toEqual([{ scope: principal, body }]);
  });

  it("ignores a tenant named in the body, the query string or a header", async () => {
    const { ingester, calls } = recorder();
    const { app } = await start({ ingester });
    const other = randomUUID();

    await app.inject({
      method: "POST",
      url: `/v1/events?organisationId=${other}&projectId=${other}`,
      headers: { ...json, "x-organisation-id": other, "x-project-id": other },
      payload: { organisationId: other, projectId: other, events: [{ organisationId: other }] },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope).toEqual(principal);
  });

  describe("without a valid credential", () => {
    it.each([
      ["no header", {}],
      ["an unknown key", { authorization: "Bearer not-the-token" }],
      ["a different scheme", { authorization: `Basic ${TOKEN}` }],
    ])("answers 401 for %s and never calls the ingester", async (_label, auth) => {
      const { ingester, calls } = recorder();
      const { app } = await start({ ingester });

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "content-type": "application/json", ...auth },
        payload: { events: [{}] },
      });

      expect(response.statusCode).toBe(401);
      expect(calls).toEqual([]);
    });

    it("answers 401 before looking at the body, even one that is too large or not JSON", async () => {
      const { ingester, calls } = recorder();
      const { app } = await start({ ingester, bodyLimit: "1000" });

      const tooLarge = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ events: [], pad: "x".repeat(5000) }),
      });
      const notJson = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "content-type": "application/json" },
        payload: "{not json",
      });

      expect(tooLarge.statusCode).toBe(401);
      expect(notJson.statusCode).toBe(401);
      expect(calls).toEqual([]);
    });
  });

  describe("a batch the ingester refuses", () => {
    it.each([
      ["events_empty", "A batch must contain at least one event"],
      ["events_missing", 'The request body must contain an "events" array'],
      ["body_not_an_object", "The request body must be a JSON object"],
      ["too_many_events", "A batch can contain at most 500 events"],
    ] as const)("answers 400 %s", async (error, message) => {
      const { ingester } = recorder({ ok: false, error });
      const { app } = await start({ ingester });

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: json,
        payload: { events: [] },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json<ErrorBody>();
      expect(body.error.code).toBe(error);
      expect(body.error.message).toContain(message);
      expect(body.error.requestId).toBe(response.headers["x-request-id"]);
    });
  });

  describe("a body that is not usable JSON", () => {
    const post = async (options: {
      headers?: Record<string, string>;
      payload?: string;
      bodyLimit?: string;
    }) => {
      const { ingester, calls } = recorder();
      const { app } = await start({
        ingester,
        ...(options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit }),
      });
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: options.headers ?? json,
        ...(options.payload === undefined ? {} : { payload: options.payload }),
      });
      return { response, calls };
    };

    it("answers 400 invalid_json for malformed JSON, without repeating the body", async () => {
      const { response, calls } = await post({ payload: '{"events": [secret-text-in-body' });
      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe("invalid_json");
      expect(response.body).not.toContain("secret-text-in-body");
      expect(calls).toEqual([]);
    });

    it("answers 400 invalid_json for an empty body", async () => {
      const { response } = await post({ payload: "" });
      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe("invalid_json");
    });

    it("answers 413 payload_too_large above the body limit", async () => {
      const { response, calls } = await post({
        bodyLimit: "1000",
        payload: JSON.stringify({ events: [], pad: "x".repeat(2000) }),
      });
      expect(response.statusCode).toBe(413);
      expect(response.json<ErrorBody>().error.code).toBe("payload_too_large");
      expect(calls).toEqual([]);
    });

    it.each([
      ["text/plain", { "content-type": "text/plain" }],
      ["form data", { "content-type": "application/x-www-form-urlencoded" }],
      ["no content type", {}],
    ])("answers 415 unsupported_media_type for %s", async (_label, extra) => {
      const { response, calls } = await post({
        headers: { authorization: `Bearer ${TOKEN}`, ...extra },
        payload: '{"events":[]}',
      });
      expect(response.statusCode).toBe(415);
      expect(response.json<ErrorBody>().error.code).toBe("unsupported_media_type");
      expect(calls).toEqual([]);
    });

    it("never shows a framework error code", async () => {
      const { response } = await post({ payload: "{" });
      expect(response.body).not.toContain("FST_");
    });
  });

  describe("when events cannot be recorded", () => {
    it("answers a generic 500 if the ingester throws, and leaks nothing", async () => {
      const ingester: EventIngester = () =>
        Promise.reject(new Error("password=hunter2 relation events is broken"));
      const { app } = await start({ ingester });

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: json,
        payload: { events: [{}] },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json<ErrorBody>().error.code).toBe("internal_error");
      expect(response.body).not.toContain("hunter2");
    });

    it("answers 503 if no ingester is configured", async () => {
      const { app } = await start({});
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: json,
        payload: { events: [{}] },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json<ErrorBody>().error.code).toBe("ingestion_unavailable");
    });
  });

  it("has no GET, PUT or DELETE", async () => {
    const { ingester } = recorder();
    const { app } = await start({ ingester });
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: "/v1/events",
        headers: json,
        payload: "{}",
      });
      expect(response.statusCode, method).toBe(404);
    }
  });

  describe("logging", () => {
    it("never writes event content to the log", async () => {
      const lines: string[] = [];
      const { ingester } = recorder();
      const { app } = await start({ ingester, logLevel: "trace", lines });

      await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: json,
        payload: { events: [{ attributes: { email: "CANARY-PERSONAL-DATA@example.com" } }] },
      });
      await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: json,
        payload: '{"events":[{"attributes":{"email":"CANARY-IN-BAD-JSON',
      });

      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).not.toContain("CANARY");
    });

    it("logs a database failure without the row that caused it", async () => {
      const lines: string[] = [];
      const ingester: EventIngester = () =>
        Promise.reject(
          Object.assign(new Error('new row for relation "events" violates check constraint'), {
            severity: "ERROR",
            code: "23514",
            table: "events",
            constraint: "events_attributes_check",
            detail: "Failing row contains (CANARY-PERSONAL-DATA)",
            where: "JSON data, line 1: CANARY-PERSONAL-DATA",
          }),
        );
      const { app } = await start({ ingester, logLevel: "debug", lines });

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: json,
        payload: { events: [{}] },
      });

      expect(response.statusCode).toBe(500);
      const log = lines.join("\n");
      expect(log).toContain("unhandled error");
      expect(log).toContain("23514");
      expect(log).toContain("events_attributes_check");
      expect(log).not.toContain("CANARY");
    });
  });
});
