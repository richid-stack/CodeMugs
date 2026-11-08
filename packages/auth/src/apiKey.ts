import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * API key format:
 *
 *     cmk_<organisation id: 32 hex>_<key id: 32 hex>_<secret: 43 base64url characters>
 *
 * The organisation id and key id are identifiers, not secrets. The organisation id is in the key
 * so the lookup can run inside that organisation's tenant transaction with row-level security
 * still on: a forged or wrong organisation id simply finds no row. The secret is 256 random bits
 * and is the only secret part. Only its SHA-256 is stored. Because the secret is random and
 * long, a fast hash is appropriate (a slow password hash protects guessable secrets, and this is
 * not one).
 */

const KEY_PATTERN = /^cmk_([0-9a-f]{32})_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

// RFC 9562 shape: the version and variant digits must be valid. Everything this system creates
// satisfies it, and it is the shape the storage layer accepts as a tenant id.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ParsedApiKey {
  organisationId: string;
  keyId: string;
  secret: string;
}

export interface GeneratedApiKey {
  /** The key's identifier. Safe to store and to log. */
  keyId: string;
  /** The full key. Show it to its owner once and never store or log it. */
  key: string;
  /** What to store instead of the key. */
  secretHash: Buffer;
}

function hexToUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidToHex(uuid: string): string {
  return uuid.replaceAll("-", "");
}

export function isOrganisationId(value: string): boolean {
  return UUID_PATTERN.test(value.toLowerCase());
}

export function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** Constant-time comparison of a presented secret with a stored hash. Never throws. */
export function secretMatches(secret: string, storedHash: Buffer): boolean {
  const presented = hashSecret(secret);
  // timingSafeEqual throws on different lengths, which would turn a malformed stored value into
  // an error path. Treat it as a mismatch instead.
  if (storedHash.length !== presented.length) return false;
  return timingSafeEqual(presented, storedHash);
}

export function generateApiKey(organisationId: string): GeneratedApiKey {
  if (!isOrganisationId(organisationId)) {
    // The value is deliberately not echoed.
    throw new TypeError("organisationId must be a UUID");
  }
  const keyId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  return {
    keyId,
    key: `cmk_${uuidToHex(organisationId.toLowerCase())}_${uuidToHex(keyId)}_${secret}`,
    secretHash: hashSecret(secret),
  };
}

/**
 * Splits a presented key into its parts, or returns undefined if it is not exactly the expected
 * shape. Never throws, whatever it is given, and never echoes the input.
 */
export function parseApiKey(presented: string): ParsedApiKey | undefined {
  // Cheap length guard before the regular expression, so an enormous header costs nothing.
  if (presented.length !== 113) return undefined;
  const match = KEY_PATTERN.exec(presented);
  const organisationHex = match?.[1];
  const keyHex = match?.[2];
  const secret = match?.[3];
  if (organisationHex === undefined || keyHex === undefined || secret === undefined) {
    return undefined;
  }
  const organisationId = hexToUuid(organisationHex);
  if (!UUID_PATTERN.test(organisationId)) return undefined;
  return { organisationId, keyId: hexToUuid(keyHex), secret };
}
