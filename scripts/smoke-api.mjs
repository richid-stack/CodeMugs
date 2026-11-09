// Smoke test for the built API. Run `pnpm build` first, then `pnpm smoke`.
//
// Starts the compiled server on a free port and checks health, readiness and the 404 shape.
// Then verifies that SIGTERM produces a clean, timely exit, that invalid configuration fails fast
// without echoing the rejected value, and that /v1 refuses to guess who is calling when it has no
// working database. None of this needs a database; the database-backed paths are covered by the
// integration tests.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../apps/api/dist/main.js",
);
const STARTUP_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

const failures = [];

function check(condition, description) {
  if (condition) {
    console.log(`  ok   ${description}`);
  } else {
    console.error(`  FAIL ${description}`);
    failures.push(description);
  }
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

function startServer(env) {
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      HOST: "127.0.0.1",
      // Empty means unset, so a developer's own database is never used by accident.
      DATABASE_URL: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let finished = false;
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  // "close" fires after stdio is drained, so captured output is complete.
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      finished = true;
      resolve({ code, signal });
    });
  });
  return { child, closed, output: () => output, hasExited: () => finished };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitUntilHealthy(baseUrl, server) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline && !server.hasExited()) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** A key in the right shape that was never issued. */
function fakeKey() {
  return `cmk_${randomUUID().replaceAll("-", "")}_${randomUUID().replaceAll("-", "")}_${"c".repeat(43)}`;
}

async function checkNormalOperation() {
  console.log("server starts, serves requests and shuts down gracefully");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer({ PORT: String(port) });

  try {
    const healthy = await waitUntilHealthy(baseUrl, server);
    check(healthy, "becomes healthy");
    if (!healthy) {
      console.error(server.output());
      return;
    }

    const ready = await fetch(`${baseUrl}/readyz`);
    const readyBody = await ready.json();
    check(ready.status === 200 && readyBody.status === "ready", "GET /readyz reports ready");

    const missing = await fetch(`${baseUrl}/does-not-exist`);
    const missingBody = await missing.json();
    check(
      missing.status === 404 &&
        missingBody.error?.code === "not_found" &&
        typeof missingBody.error?.requestId === "string",
      "unknown routes return the structured 404 with a request id",
    );
    check(missing.headers.get("x-content-type-options") === "nosniff", "security headers are set");

    // No database is configured, so there is nothing to check a key against. Even a request that
    // presents a key must be refused rather than waved through.
    for (const headers of [{}, { authorization: `Bearer ${fakeKey()}` }]) {
      const whoami = await fetch(`${baseUrl}/v1/whoami`, { headers });
      const whoamiBody = await whoami.json();
      check(
        whoami.status === 503 && whoamiBody.error?.code === "authentication_unavailable",
        `GET /v1/whoami ${Object.keys(headers).length === 0 ? "without" : "with"} a key answers 503 when no database is configured`,
      );
    }

    // The same for sending events: with nothing to check the key against, nothing is accepted.
    const events = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${fakeKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    check(
      events.status === 503,
      `POST /v1/events answers 503 when no database is configured (status=${events.status})`,
    );

    server.child.kill("SIGTERM");
    const result = await withTimeout(server.closed, SHUTDOWN_TIMEOUT_MS, "graceful shutdown");
    check(
      result.code === 0,
      `exits with code 0 after SIGTERM (code=${result.code}, signal=${result.signal})`,
    );

    const stillAccepting = await fetch(`${baseUrl}/healthz`).then(
      () => true,
      () => false,
    );
    check(!stillAccepting, "stops accepting connections after shutdown");
  } finally {
    server.child.kill("SIGKILL");
  }
}

async function checkInvalidConfiguration() {
  console.log("invalid configuration fails fast without echoing values");
  const rejectedValue = "smoke-test-rejected-value";
  const server = startServer({ PORT: rejectedValue });

  try {
    const result = await withTimeout(server.closed, STARTUP_TIMEOUT_MS, "startup failure");
    const output = server.output();
    check(result.code === 1, `exits with code 1 (code=${result.code})`);
    check(output.includes("PORT"), "names the offending variable");
    check(!output.includes(rejectedValue), "does not echo the rejected value");
  } finally {
    server.child.kill("SIGKILL");
  }
}

async function checkInvalidDatabaseUrl() {
  console.log("an invalid DATABASE_URL fails fast without echoing it");
  const rejectedValue = "smoke-test-not-a-url-with-password-hunter2";
  const server = startServer({ PORT: "0", DATABASE_URL: rejectedValue });

  try {
    const result = await withTimeout(server.closed, STARTUP_TIMEOUT_MS, "startup failure");
    const output = server.output();
    check(result.code === 1, `exits with code 1 (code=${result.code})`);
    check(output.includes("DATABASE_URL"), "names the offending variable");
    check(!output.includes(rejectedValue), "does not echo the rejected value");
    check(!output.includes("hunter2"), "does not echo any part of the rejected value");
  } finally {
    server.child.kill("SIGKILL");
  }
}

async function checkProductionRequiresDatabase() {
  console.log("production refuses to start without a database");
  const server = startServer({ PORT: "0", NODE_ENV: "production" });

  try {
    const result = await withTimeout(server.closed, STARTUP_TIMEOUT_MS, "startup failure");
    check(result.code === 1, `exits with code 1 (code=${result.code})`);
    check(server.output().includes("DATABASE_URL"), "names the missing variable");
  } finally {
    server.child.kill("SIGKILL");
  }
}

async function checkUnreachableDatabase() {
  console.log("an unreachable database is reported as unavailable, never as a bad key");
  // Random per run, so there is no password-shaped literal in the source for a secret scanner
  // to flag, and it cannot match anything by accident.
  const password = `probe-${randomUUID()}`;
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  // Port 1 refuses connections at once.
  const server = startServer({
    PORT: String(port),
    // Logging is on here so the check on the output below has something to look at.
    LOG_LEVEL: "info",
    DATABASE_URL: `postgres://codemugs_app:${password}@127.0.0.1:1/codemugs`,
  });

  try {
    const healthy = await waitUntilHealthy(baseUrl, server);
    check(healthy, "still starts and reports liveness");
    if (!healthy) {
      console.error(server.output());
      return;
    }

    const ready = await fetch(`${baseUrl}/readyz`);
    const readyBody = await ready.json();
    check(
      ready.status === 503 && readyBody.checks?.database === "fail",
      "GET /readyz reports the database as failed",
    );

    const whoami = await fetch(`${baseUrl}/v1/whoami`, {
      headers: { authorization: `Bearer ${fakeKey()}` },
    });
    const text = await whoami.text();
    check(whoami.status === 500, `GET /v1/whoami answers 500, not 401 (status=${whoami.status})`);

    // Events must not be acknowledged when nothing can check the key or store them.
    const events = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${fakeKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    check(events.status === 500, `POST /v1/events answers 500, not 202 (status=${events.status})`);
    check(
      !text.includes(password) && !text.includes("127.0.0.1") && !text.includes("ECONNREFUSED"),
      "the error response exposes nothing about the database",
    );
    // Wait for the line about the failed request, so the check below cannot pass on empty output.
    const deadline = Date.now() + 2_000;
    while (!server.output().includes("unhandled error") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check(server.output().includes("unhandled error"), "the failure is logged for operators");
    check(!server.output().includes(password), "the password never reaches the process output");
  } finally {
    server.child.kill("SIGKILL");
  }
}

if (!existsSync(entry)) {
  console.error(`${entry} not found. Run \`pnpm build\` first.`);
  process.exit(1);
}

try {
  await checkNormalOperation();
  await checkInvalidConfiguration();
  await checkInvalidDatabaseUrl();
  await checkProductionRequiresDatabase();
  await checkUnreachableDatabase();
} catch (error) {
  check(false, `unexpected error: ${error instanceof Error ? error.message : String(error)}`);
}

if (failures.length > 0) {
  console.error(
    `\nsmoke test failed (${failures.length} check${failures.length === 1 ? "" : "s"})`,
  );
  process.exitCode = 1;
} else {
  console.log("\nsmoke test passed");
}
