// Smoke test for the built API. Run `pnpm build` first, then `pnpm smoke`.
//
// Starts the compiled server on a free port and checks health, readiness and the 404 shape.
// Then verifies that SIGTERM produces a clean, timely exit, and that invalid configuration
// fails fast without echoing the rejected value.
import { spawn } from "node:child_process";
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
    env: { ...process.env, NODE_ENV: "test", LOG_LEVEL: "silent", HOST: "127.0.0.1", ...env },
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

if (!existsSync(entry)) {
  console.error(`${entry} not found. Run \`pnpm build\` first.`);
  process.exit(1);
}

try {
  await checkNormalOperation();
  await checkInvalidConfiguration();
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
