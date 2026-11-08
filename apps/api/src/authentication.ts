import type { Principal } from "@codemugs/auth";

/**
 * Checks a presented API key and returns who it belongs to, or undefined if it is not valid.
 * It must throw, not return undefined, when it cannot decide (for example the database is
 * down): an outage must never look like "not authenticated", and never like "authenticated".
 */
export type Authenticator = (presentedKey: string) => Promise<Principal | undefined>;

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Who the request is from, set only on authenticated routes and only from a valid
     * credential. It is the single source of tenant identity: nothing in the body, query string
     * or other headers is ever used for it (repository invariant 1).
     */
    principal: Principal | null;
  }
}

// "Bearer" is case-insensitive (RFC 9110). Exactly one space and one token, with a generous cap:
// a real key is 113 characters, so anything near the cap is not one.
const BEARER_HEADER = /^Bearer ([^\s]{1,512})$/i;

/** The token from an `Authorization: Bearer <token>` header, or undefined for any other shape. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  return BEARER_HEADER.exec(header)?.[1];
}
