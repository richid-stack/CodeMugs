import { IdentityError } from "./errors.js";

/**
 * What an API key may do, fixed when it is issued (ADR 0033). A scope names a kind of thing and the
 * direction; a key has the scopes it was given and no others, and no scope includes another.
 *
 * - `events:write`: send events. The key of an SDK, which can be read by whoever has the application.
 * - `analysis:write`: connect a project to a repository and ask for an analysis, which costs a
 *   download and a sandbox run and reads a customer's code.
 * - `analysis:read`: read what the analyses found, which describes a customer's code.
 */
export const API_KEY_SCOPES = ["events:write", "analysis:read", "analysis:write"] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** What a key that is issued with no scopes named may do: what every key could do before scopes. */
export const DEFAULT_API_KEY_SCOPES: readonly ApiKeyScope[] = Object.freeze(["events:write"]);

const KNOWN: ReadonlySet<string> = new Set(API_KEY_SCOPES);

/**
 * The scopes to issue a key with: the default for none named, otherwise the named ones without
 * repeats, in a fixed order. An empty list, a scope that is not known, or anything that is not a
 * list of strings is refused (`invalid_scopes`): a key that can do nothing, or that does more than
 * was meant because a word was misspelt, is a mistake that should not be issued.
 */
export function checkScopes(requested: readonly string[] | undefined): readonly ApiKeyScope[] {
  if (requested === undefined) return DEFAULT_API_KEY_SCOPES;
  if (!Array.isArray(requested) || requested.length === 0)
    throw new IdentityError("invalid_scopes");
  const wanted = new Set<string>();
  for (const scope of requested as unknown[]) {
    if (typeof scope !== "string" || !KNOWN.has(scope)) throw new IdentityError("invalid_scopes");
    wanted.add(scope);
  }
  return API_KEY_SCOPES.filter((scope) => wanted.has(scope));
}

/**
 * The scopes that a stored key has, from what the database gave. One that is not known is dropped
 * and never granted: a key cannot gain a power by a word that this code does not understand.
 */
export function knownScopes(stored: unknown): readonly ApiKeyScope[] {
  if (!Array.isArray(stored)) return [];
  return API_KEY_SCOPES.filter((scope) => (stored as unknown[]).includes(scope));
}
