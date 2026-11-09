import type { FastifyInstance } from "fastify";
import { bearerToken, type Authenticator } from "../authentication.js";
import type { EventIngester } from "../ingestion.js";
import { registerEventRoutes } from "./events.js";

export interface V1RoutesOptions {
  /** Without one, every /v1 route answers 503: the API refuses to guess who is calling. */
  authenticator: Authenticator | undefined;
  /** Without one, `POST /v1/events` answers 503. */
  ingester: EventIngester | undefined;
}

/**
 * Everything under /v1 requires a valid API key. The check is a hook on the encapsulated scope
 * that holds the routes, so a route added here later is protected by construction: there is no
 * way to register an unauthenticated /v1 route by forgetting something. Health routes live
 * outside this scope and stay public.
 *
 * Every credential failure (missing, malformed, unknown, wrong secret, revoked) gets the same
 * response. A failure of the authenticator itself is not a credential failure: it propagates to
 * the error handler and becomes a generic 500.
 */
export function registerV1Routes(
  app: FastifyInstance,
  { authenticator, ingester }: V1RoutesOptions,
): void {
  void app.register(
    (v1, _options, done) => {
      v1.addHook("onRequest", async (request, reply) => {
        if (authenticator === undefined) {
          return reply.code(503).send({
            error: {
              code: "authentication_unavailable",
              message: "Authentication is not available",
              requestId: request.id,
            },
          });
        }

        const token = bearerToken(request.headers.authorization);
        const principal = token === undefined ? undefined : await authenticator(token);
        if (principal === undefined) {
          // Never log the credential or say why it failed.
          request.log.info("authentication failed");
          return reply
            .code(401)
            .header("www-authenticate", 'Bearer realm="codemugs"')
            .send({
              error: {
                code: "unauthorized",
                message: "Missing or invalid credentials",
                requestId: request.id,
              },
            });
        }

        request.principal = principal;
        // The reply holds its own copy of the logger, taken when the request began. Setting both
        // puts the caller on every line for this request, including "request completed".
        const log = request.log.child({
          organisationId: principal.organisationId,
          projectId: principal.projectId,
          apiKeyId: principal.apiKeyId,
        });
        request.log = log;
        reply.log = log;
      });

      // Authenticated responses describe one tenant and must not be stored by any cache.
      v1.addHook("onSend", (_request, reply, _payload, hookDone) => {
        void reply.header("cache-control", "no-store");
        hookDone();
      });

      /** Who the credential belongs to. Lets an SDK check a key without sending any data. */
      v1.get("/whoami", (request) => {
        const principal = request.principal;
        if (principal === null) {
          // Unreachable: the hook above answers every request that has no principal.
          throw new Error("authenticated route reached without a principal");
        }
        return {
          organisationId: principal.organisationId,
          projectId: principal.projectId,
          apiKeyId: principal.apiKeyId,
        };
      });

      registerEventRoutes(v1, { ingester });

      done();
    },
    { prefix: "/v1" },
  );
}
