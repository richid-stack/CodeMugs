import { loadApiConfig } from "@codemugs/configuration";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import type { ReadinessCheck } from "./routes/health.js";

const config = loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const opened: BuiltApp[] = [];

async function create(readinessChecks: ReadinessCheck[] = []): Promise<BuiltApp> {
  const built = await buildApp({ config, readinessChecks });
  opened.push(built);
  return built;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map(({ app }) => app.close()));
});

describe("liveness", () => {
  it("GET /healthz returns 200", async () => {
    const { app } = await create();
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe("ok");
  });

  it("stays healthy even when a dependency is down", async () => {
    const { app } = await create([
      { name: "database", check: () => Promise.reject(new Error("connection refused")) },
    ]);
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
  });
});

describe("readiness", () => {
  it("returns 200 when there are no checks or all checks pass", async () => {
    const { app } = await create([{ name: "database", check: () => Promise.resolve() }]);
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ checks: Record<string, string> }>().checks).toEqual({ database: "ok" });
  });

  it("returns 503 when a check fails, without leaking the error details", async () => {
    const { app } = await create([
      {
        name: "database",
        check: () => Promise.reject(new Error("password=hunter2 connection refused")),
      },
    ]);
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ checks: Record<string, string> }>().checks).toEqual({
      database: "fail",
    });
    expect(response.body).not.toContain("hunter2");
  });

  it("returns 503 when a check hangs past its timeout", async () => {
    const { app } = await create([
      { name: "slow", check: () => new Promise<void>(() => undefined), timeoutMs: 20 },
    ]);
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ checks: Record<string, string> }>().checks).toEqual({ slow: "fail" });
  });

  it("returns 503 once shutdown has begun", async () => {
    const { app, health } = await create();
    health.shuttingDown = true;
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ status: string }>().status).toBe("shutting_down");
  });
});

describe("request handling", () => {
  it("echoes a well-formed caller-supplied request id", async () => {
    const { app } = await create();
    const response = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "trace-abc12345" },
    });
    expect(response.headers["x-request-id"]).toBe("trace-abc12345");
  });

  it("replaces a malformed request id with a generated one", async () => {
    const { app } = await create();
    const response = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "bad id with spaces <script>" },
    });
    const id = response.headers["x-request-id"];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sets baseline security headers", async () => {
    const { app } = await create();
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("returns a structured 404 for unknown routes", async () => {
    const { app } = await create();
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string; requestId: string } }>();
    expect(body.error.code).toBe("not_found");
    expect(body.error.requestId).toBe(response.headers["x-request-id"]);
  });

  it("hides internal details of unexpected server errors", async () => {
    const { app } = await create();
    app.get("/boom", () => {
      throw new Error("db password leaked in stack");
    });
    const response = await app.inject({ method: "GET", url: "/boom" });
    expect(response.statusCode).toBe(500);
    expect(response.json<{ error: { message: string } }>().error.message).toBe(
      "Internal server error",
    );
    expect(response.body).not.toContain("leaked");
  });
});
