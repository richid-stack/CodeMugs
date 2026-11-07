import { randomUUID } from "node:crypto";
import helmet from "@fastify/helmet";
import type { ApiConfig } from "@codemugs/configuration";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { registerHealthRoutes, type HealthState, type ReadinessCheck } from "./routes/health.js";

// Callers may supply a request id for cross-service tracing, but only in a safe shape.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface BuildAppOptions {
  config: ApiConfig;
  readinessChecks?: readonly ReadinessCheck[];
}

export interface BuiltApp {
  app: FastifyInstance;
  health: HealthState;
}

export async function buildApp({
  config,
  readinessChecks = [],
}: BuildAppOptions): Promise<BuiltApp> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-api-key"]'],
        censor: "[redacted]",
      },
    },
    bodyLimit: config.bodyLimitBytes,
    genReqId: (request) => {
      const incoming = request.headers["x-request-id"];
      return typeof incoming === "string" && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  await app.register(helmet);

  app.addHook("onSend", (request, reply, _payload, done) => {
    void reply.header("x-request-id", request.id);
    done();
  });

  // One error shape for every failure. Server errors never expose internals to callers.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode =
      error.statusCode !== undefined && error.statusCode >= 400 ? error.statusCode : 500;
    const isServerError = statusCode >= 500;
    if (isServerError) {
      request.log.error({ err: error }, "unhandled error");
    }
    void reply.code(statusCode).send({
      error: {
        code: isServerError ? "internal_error" : error.code,
        message: isServerError ? "Internal server error" : error.message,
        requestId: request.id,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: { code: "not_found", message: "Route not found", requestId: request.id },
    });
  });

  const health: HealthState = { shuttingDown: false };
  registerHealthRoutes(app, { checks: readinessChecks, state: health });

  return { app, health };
}
