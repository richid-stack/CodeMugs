import type { FastifyInstance } from "fastify";

export interface ReadinessCheck {
  name: string;
  /** Resolve if the dependency is usable; reject (or time out) if it is not. */
  check: () => Promise<void>;
  timeoutMs?: number;
}

export interface HealthState {
  /** Flipped to true when shutdown begins so load balancers stop routing new traffic. */
  shuttingDown: boolean;
}

export interface HealthRoutesOptions {
  checks: readonly ReadinessCheck[];
  state: HealthState;
}

const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

async function runCheck({ name, check, timeoutMs = DEFAULT_CHECK_TIMEOUT_MS }: ReadinessCheck) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`readiness check "${name}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([check(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * - `GET /healthz` is liveness: the process is up and the event loop is responsive. It never
 *   touches dependencies, so a database outage cannot cause the process to be restarted.
 * - `GET /readyz` is readiness: dependencies are reachable and we are not shutting down.
 *   Failure details are logged server-side and never returned to the caller.
 */
export function registerHealthRoutes(app: FastifyInstance, { checks, state }: HealthRoutesOptions) {
  app.get("/healthz", () => ({ status: "ok" }));

  app.get("/readyz", async (request, reply) => {
    if (state.shuttingDown) {
      return reply.code(503).send({ status: "shutting_down" });
    }

    const settled = await Promise.allSettled(checks.map((check) => runCheck(check)));
    const report: Record<string, "ok" | "fail"> = {};

    settled.forEach((result, index) => {
      const check = checks[index];
      if (!check) return;
      if (result.status === "fulfilled") {
        report[check.name] = "ok";
      } else {
        report[check.name] = "fail";
        request.log.warn({ err: result.reason, check: check.name }, "readiness check failed");
      }
    });

    const ready = Object.values(report).every((outcome) => outcome === "ok");
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "unavailable",
      checks: report,
    });
  });
}
