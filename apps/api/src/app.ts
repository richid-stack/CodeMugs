import { randomUUID } from "node:crypto";
import helmet from "@fastify/helmet";
import type { ApiConfig } from "@codemugs/configuration";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Authenticator } from "./authentication.js";
import type { EventIngester } from "./ingestion.js";
import { serializeError } from "./logging.js";
import { registerHealthRoutes, type HealthState, type ReadinessCheck } from "./routes/health.js";
import { registerV1Routes } from "./routes/v1.js";

// Fastify reports a bad body with its own error codes. Clients get stable ones instead, so the
// framework can change without changing the API.
const CLIENT_ERROR_CODES: Readonly<Record<string, string>> = {
  FST_ERR_CTP_INVALID_JSON_BODY: "invalid_json",
  FST_ERR_CTP_EMPTY_JSON_BODY: "invalid_json",
  FST_ERR_CTP_BODY_TOO_LARGE: "payload_too_large",
  FST_ERR_CTP_INVALID_MEDIA_TYPE: "unsupported_media_type",
};

function publicErrorCode(error: FastifyError): string {
  const mapped = CLIENT_ERROR_CODES[error.code];
  if (mapped !== undefined) return mapped;
  return error.code.startsWith("FST_") ? "invalid_request" : error.code;
}

// Callers may supply a request id for cross-service tracing, but only in a safe shape.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface BuildAppOptions {
  config: ApiConfig;
  readinessChecks?: readonly ReadinessCheck[];
  /** Decides who an API key belongs to. Without one, every /v1 route answers 503. */
  authenticator?: Authenticator;
  /** Records the events of `POST /v1/events`. Without one, that route answers 503. */
  ingester?: EventIngester;
  /** Where log lines go. For tests that need to read them; production logs to stdout. */
  logStream?: { write(line: string): void };
}

export interface BuiltApp {
  app: FastifyInstance;
  health: HealthState;
}

export async function buildApp({
  config,
  readinessChecks = [],
  authenticator,
  ingester,
  logStream,
}: BuildAppOptions): Promise<BuiltApp> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-api-key"]'],
        censor: "[redacted]",
      },
      // Database errors carry the failing row. See logging.ts.
      serializers: { err: serializeError },
      ...(logStream === undefined ? {} : { stream: logStream }),
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

  // The API speaks JSON. Fastify also parses text/plain by default and would hand the route a
  // string, which would read as "body must be an object" instead of "wrong content type".
  app.removeContentTypeParser("text/plain");

  // Where an authenticated request keeps its caller (see authentication.ts). Starts empty on
  // every request.
  app.decorateRequest("principal", null);

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
        code: isServerError ? "internal_error" : publicErrorCode(error),
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
  // After the error handler is set, so the routes in this scope inherit it.
  registerV1Routes(app, { authenticator, ingester });

  return { app, health };
}
