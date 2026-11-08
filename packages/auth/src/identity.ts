import { randomUUID } from "node:crypto";
import { postgresErrorCode, withTenant, type Pool } from "@codemugs/storage";
import { z } from "zod";
import { generateApiKey, parseApiKey, secretMatches } from "./apiKey.js";
import { recordAudit, type AuditActor } from "./audit.js";
import { IdentityError } from "./errors.js";

/** Who a valid API key says is calling. This is the only source of tenant identity. */
export interface Principal {
  organisationId: string;
  projectId: string;
  apiKeyId: string;
}

export interface IssuedApiKey {
  id: string;
  /** The full key. It exists only here: it is not stored, so it cannot be shown again. */
  key: string;
}

const nameSchema = z.string().min(1).max(200);
const idSchema = z.uuid();

// Compared against when a key id does not exist, so "no such key" and "wrong secret" do the same
// work. The database round trip dominates the timing either way; this only avoids adding a
// second difference.
const NO_SUCH_KEY_HASH = Buffer.alloc(32);

function checkName(name: string): string {
  const parsed = nameSchema.safeParse(name);
  if (!parsed.success) throw new IdentityError("invalid_name");
  return parsed.data;
}

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Creates an organisation. The organisation is the tenant, so its id is chosen here and set as
 * the tenant for the insert: the database only lets an organisation be created by acting as
 * itself.
 */
export async function createOrganisation(
  pool: Pool,
  options: { name: string; actor?: AuditActor },
): Promise<{ id: string }> {
  const name = checkName(options.name);
  const id = randomUUID();
  await withTenant(pool, id, async (client) => {
    await client.query("INSERT INTO organisations (id, name) VALUES ($1, $2)", [id, name]);
    await recordAudit(client, {
      actor: options.actor ?? { type: "system" },
      action: "organisation.created",
      target: { type: "organisation", id },
    });
  });
  return { id };
}

export async function createProject(
  pool: Pool,
  organisationId: string,
  options: { name: string; actor: AuditActor; requestId?: string },
): Promise<{ id: string }> {
  const name = checkName(options.name);
  try {
    return await withTenant(pool, organisationId, async (client) => {
      const result = await client.query<{ id: string }>(
        "INSERT INTO projects (organisation_id, name) VALUES ($1, $2) RETURNING id",
        [client.organisationId, name],
      );
      const id = result.rows[0]?.id;
      if (id === undefined) throw new Error("project insert returned no row");
      await recordAudit(client, {
        actor: options.actor,
        action: "project.created",
        target: { type: "project", id },
        ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      });
      return { id };
    });
  } catch (error) {
    if (postgresErrorCode(error) === UNIQUE_VIOLATION) throw new IdentityError("already_exists");
    throw error;
  }
}

/**
 * Issues an API key for one project of the organisation. The key is returned once. Only the
 * SHA-256 of its secret is stored, and the key never reaches a log or the audit trail.
 *
 * A project that does not exist and a project that belongs to another organisation give the
 * same error, so this cannot be used to find out which projects exist.
 */
export async function issueApiKey(
  pool: Pool,
  organisationId: string,
  projectId: string,
  options: { name: string; actor: AuditActor; requestId?: string },
): Promise<IssuedApiKey> {
  const name = checkName(options.name);
  if (!idSchema.safeParse(projectId).success) throw new IdentityError("project_not_found");

  const generated = generateApiKey(organisationId);
  try {
    await withTenant(pool, organisationId, async (client) => {
      await client.query(
        `INSERT INTO api_keys (id, organisation_id, project_id, name, secret_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [generated.keyId, client.organisationId, projectId, name, generated.secretHash],
      );
      await recordAudit(client, {
        actor: options.actor,
        action: "api_key.issued",
        target: { type: "api_key", id: generated.keyId },
        metadata: { projectId },
        ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      });
    });
  } catch (error) {
    // The composite foreign key (organisation_id, project_id) fails for both a missing project
    // and another organisation's project.
    if (postgresErrorCode(error) === FOREIGN_KEY_VIOLATION) {
      throw new IdentityError("project_not_found");
    }
    throw error;
  }
  return { id: generated.keyId, key: generated.key };
}

/**
 * Revokes a key of the organisation. Returns true if this call revoked it, and false if there
 * was nothing to revoke (it does not exist in this organisation, or was already revoked).
 * Revocation is permanent.
 */
export async function revokeApiKey(
  pool: Pool,
  organisationId: string,
  apiKeyId: string,
  options: { actor: AuditActor; requestId?: string },
): Promise<boolean> {
  if (!idSchema.safeParse(apiKeyId).success) return false;
  return withTenant(pool, organisationId, async (client) => {
    const result = await client.query(
      "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
      [apiKeyId],
    );
    if (result.rowCount === 0) return false;
    await recordAudit(client, {
      actor: options.actor,
      action: "api_key.revoked",
      target: { type: "api_key", id: apiKeyId },
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    });
    return true;
  });
}

interface KeyRow {
  organisation_id: string;
  project_id: string;
  secret_hash: Buffer;
  revoked_at: Date | null;
}

/**
 * Checks a presented API key and returns who it belongs to, or undefined if it is not valid.
 * Malformed, unknown, wrong-secret and revoked keys are all the same answer. A database failure
 * is not an answer: it throws, so an outage can never be mistaken for "not authenticated" or,
 * worse, for "authenticated".
 *
 * The lookup runs inside the tenant transaction of the organisation the key claims. That claim
 * is not trusted: row-level security means the key can only be found there, and the secret must
 * still match.
 */
export async function authenticateApiKey(
  pool: Pool,
  presented: string,
): Promise<Principal | undefined> {
  const parsed = parseApiKey(presented);
  if (parsed === undefined) return undefined;

  const row = await withTenant(pool, parsed.organisationId, async (client) => {
    const result = await client.query<KeyRow>(
      "SELECT organisation_id, project_id, secret_hash, revoked_at FROM api_keys WHERE id = $1",
      [parsed.keyId],
    );
    return result.rows[0];
  });

  const matches = secretMatches(parsed.secret, row?.secret_hash ?? NO_SUCH_KEY_HASH);
  if (row === undefined || !matches || row.revoked_at !== null) return undefined;

  return {
    organisationId: row.organisation_id,
    projectId: row.project_id,
    apiKeyId: parsed.keyId,
  };
}
