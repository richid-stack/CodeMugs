import type { ApiKeyScope } from "@codemugs/auth";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * A hook for a route that needs a scope of the key (ADR 0033). It runs before the body is read, so
 * a key that may not do the thing is refused without its body being parsed or looked at, and it
 * runs after the authentication hook of the `/v1` scope, so there is always a principal.
 *
 * A key that does not have the scope is told which scope the route needs: the scopes are part of
 * the API and say nothing of any tenant. The answer is `403` and is the same whatever the route
 * would have done with the request, so it does not reveal whether what the request names exists.
 */
export function requireScope(scope: ApiKeyScope) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const principal = request.principal;
    if (principal === null) {
      // Unreachable: the authentication hook answers every request that has no principal.
      throw new Error("authenticated route reached without a principal");
    }
    if (principal.scopes.includes(scope)) return;
    request.log.info({ scope }, "key lacks the scope that the route needs");
    return reply.code(403).send({
      error: {
        code: "forbidden",
        message: `This API key does not have the "${scope}" scope`,
        requestId: request.id,
      },
    });
  };
}
