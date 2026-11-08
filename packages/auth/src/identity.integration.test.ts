import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createPool, postgresErrorCode, withTenant, type Pool } from "@codemugs/storage";
import {
  adminDatabaseUrl,
  createTestDatabase,
  findSchemaViolations,
  type TestDatabase,
} from "@codemugs/storage/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAudit } from "./audit.js";
import { IdentityError } from "./errors.js";
import {
  authenticateApiKey,
  createOrganisation,
  createProject,
  issueApiKey,
  revokeApiKey,
  type IssuedApiKey,
} from "./identity.js";

const describeDatabase = adminDatabaseUrl() === undefined ? describe.skip : describe;

const SYSTEM = { type: "system" } as const;

/** The error a promise rejects with. Fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

function only<T>(rows: T[]): T {
  if (rows.length !== 1) throw new Error(`expected one row but got ${rows.length}`);
  return rows[0] as T;
}

/**
 * Splits a key into its three parts so a test can tamper with exactly one of them. It cuts at
 * fixed positions because the secret may itself contain underscores, so splitting on "_" would
 * truncate it and make later "rejects a tampered key" tests pass for the wrong reason.
 */
function parts(key: string): { organisation: string; keyId: string; secret: string } {
  const organisation = key.slice(4, 36);
  const keyId = key.slice(37, 69);
  const secret = key.slice(70);
  if (secret.length !== 43 || `cmk_${organisation}_${keyId}_${secret}` !== key) {
    throw new Error("test helper could not split the key");
  }
  return { organisation, keyId, secret };
}

const hex = (uuid: string): string => uuid.replaceAll("-", "");

describeDatabase("identity against PostgreSQL", () => {
  const cleanup: Array<() => Promise<void>> = [];
  let database: TestDatabase;
  let app: Pool;
  let admin: Pool;
  let orgA: string;
  let orgB: string;
  let projectA: string;
  let projectB: string;
  let keyA: IssuedApiKey;
  let keyB: IssuedApiKey;

  beforeAll(async () => {
    database = await createTestDatabase();
    cleanup.unshift(() => database.drop());
    app = createPool({ connectionString: database.appUrl, maxConnections: 4 });
    cleanup.unshift(() => app.end());
    admin = createPool({ connectionString: database.adminUrl, maxConnections: 2 });
    cleanup.unshift(() => admin.end());

    orgA = (await createOrganisation(app, { name: "Organisation A" })).id;
    orgB = (await createOrganisation(app, { name: "Organisation B" })).id;
    projectA = (await createProject(app, orgA, { name: "alpha", actor: SYSTEM })).id;
    projectB = (await createProject(app, orgB, { name: "beta", actor: SYSTEM })).id;
    keyA = await issueApiKey(app, orgA, projectA, { name: "ci", actor: SYSTEM });
    keyB = await issueApiKey(app, orgB, projectB, { name: "ci", actor: SYSTEM });
  }, 60_000);

  afterAll(async () => {
    for (const close of cleanup) await close();
  });

  async function adminCount(sql: string, values: unknown[] = []): Promise<number> {
    const result = await admin.query<{ count: string }>(sql, values);
    return Number(only(result.rows).count);
  }

  describe("authenticating", () => {
    it("returns the organisation, project and key that a valid key belongs to", async () => {
      expect(await authenticateApiKey(app, keyA.key)).toEqual({
        organisationId: orgA,
        projectId: projectA,
        apiKeyId: keyA.id,
      });
      expect(await authenticateApiKey(app, keyB.key)).toEqual({
        organisationId: orgB,
        projectId: projectB,
        apiKeyId: keyB.id,
      });
    });

    it("rejects the right key id with the wrong secret", async () => {
      const { organisation, keyId } = parts(keyA.key);
      const wrong = `cmk_${organisation}_${keyId}_${randomBytes(32).toString("base64url")}`;
      expect(await authenticateApiKey(app, wrong)).toBeUndefined();
    });

    it("rejects a key that claims another organisation than the one that issued it", async () => {
      const { keyId, secret } = parts(keyA.key);
      const forged = `cmk_${hex(orgB)}_${keyId}_${secret}`;
      expect(await authenticateApiKey(app, forged)).toBeUndefined();
    });

    it("rejects a key for an organisation that does not exist, without an error", async () => {
      const { keyId, secret } = parts(keyA.key);
      expect(await authenticateApiKey(app, `cmk_${hex(randomUUID())}_${keyId}_${secret}`)).toBe(
        undefined,
      );
    });

    it("rejects a well-formed key whose organisation id is not a valid UUID, without an error", async () => {
      const { keyId, secret } = parts(keyA.key);
      expect(await authenticateApiKey(app, `cmk_${"a".repeat(32)}_${keyId}_${secret}`)).toBe(
        undefined,
      );
    });

    it("rejects a key id that was never issued", async () => {
      const { organisation, secret } = parts(keyA.key);
      expect(
        await authenticateApiKey(app, `cmk_${organisation}_${hex(randomUUID())}_${secret}`),
      ).toBe(undefined);
    });

    it("keeps working keys working when another key is revoked", async () => {
      const first = await issueApiKey(app, orgA, projectA, { name: "first", actor: SYSTEM });
      const second = await issueApiKey(app, orgA, projectA, { name: "second", actor: SYSTEM });
      await revokeApiKey(app, orgA, first.id, { actor: SYSTEM });
      expect(await authenticateApiKey(app, first.key)).toBeUndefined();
      expect(await authenticateApiKey(app, second.key)).toMatchObject({ apiKeyId: second.id });
    });

    it("keeps each key tied to the right organisation when many are issued at once", async () => {
      const issued = await Promise.all(
        Array.from({ length: 20 }, (_, index) => {
          const [org, project] = index % 2 === 0 ? [orgA, projectA] : [orgB, projectB];
          return issueApiKey(app, org, project, { name: `bulk-${index}`, actor: SYSTEM }).then(
            (key) => ({ key, org, project }),
          );
        }),
      );
      const principals = await Promise.all(
        issued.map(({ key }) => authenticateApiKey(app, key.key)),
      );
      principals.forEach((principal, index) => {
        expect(principal).toEqual({
          organisationId: issued[index]?.org,
          projectId: issued[index]?.project,
          apiKeyId: issued[index]?.key.id,
        });
      });
    });
  });

  describe("issuing keys", () => {
    it("stores a hash of the secret and never the key or the secret", async () => {
      const issued = await issueApiKey(app, orgA, projectA, { name: "inspect", actor: SYSTEM });
      const { secret } = parts(issued.key);

      const stored = await admin.query<{ secret_hash: Buffer }>(
        "SELECT secret_hash FROM api_keys WHERE id = $1",
        [issued.id],
      );
      expect(
        only(stored.rows).secret_hash.equals(createHash("sha256").update(secret).digest()),
      ).toBe(true);

      // Search every column of every row in both tables, as text, for the secret and the key.
      const dump = await admin.query<{ everything: string }>(
        `SELECT (SELECT coalesce(string_agg(to_jsonb(k)::text, ' '), '') FROM api_keys k)
             || (SELECT coalesce(string_agg(to_jsonb(a)::text, ' '), '') FROM audit_log a)
             || (SELECT coalesce(string_agg(to_jsonb(p)::text, ' '), '') FROM projects p)
             || (SELECT coalesce(string_agg(to_jsonb(o)::text, ' '), '') FROM organisations o)
             AS everything`,
      );
      const everything = only(dump.rows).everything;
      expect(everything).not.toContain(secret);
      expect(everything).not.toContain(issued.key);
    });

    it("refuses another organisation's project, with the same error as a missing project", async () => {
      const foreign = await rejection(
        issueApiKey(app, orgA, projectB, { name: "forged", actor: SYSTEM }),
      );
      const missing = await rejection(
        issueApiKey(app, orgA, randomUUID(), { name: "forged", actor: SYSTEM }),
      );
      expect(foreign).toBeInstanceOf(IdentityError);
      expect((foreign as IdentityError).code).toBe("project_not_found");
      expect(missing).toBeInstanceOf(IdentityError);
      expect((missing as IdentityError).code).toBe("project_not_found");
      expect((missing as Error).message).toBe((foreign as Error).message);
      expect(
        await adminCount(
          "SELECT count(*) AS count FROM api_keys WHERE organisation_id = $1 AND project_id = $2",
          [orgA, projectB],
        ),
      ).toBe(0);
    });

    it("refuses an organisation that does not exist, with the same error", async () => {
      const error = await rejection(
        issueApiKey(app, randomUUID(), projectA, { name: "ghost", actor: SYSTEM }),
      );
      expect(error).toBeInstanceOf(IdentityError);
      expect((error as IdentityError).code).toBe("project_not_found");
    });

    it("refuses a project name that is already used in the organisation, and records nothing", async () => {
      const before = await adminCount(
        "SELECT count(*) AS count FROM audit_log WHERE organisation_id = $1 AND action = 'project.created'",
        [orgA],
      );
      const error = await rejection(createProject(app, orgA, { name: "alpha", actor: SYSTEM }));
      expect((error as IdentityError).code).toBe("already_exists");
      const after = await adminCount(
        "SELECT count(*) AS count FROM audit_log WHERE organisation_id = $1 AND action = 'project.created'",
        [orgA],
      );
      expect(after).toBe(before);
    });

    it("allows the same project name in a different organisation", async () => {
      const created = await createProject(app, orgB, { name: "alpha", actor: SYSTEM });
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe("revoking keys", () => {
    it("revokes once, reports false the second time, and the key stops working", async () => {
      const issued = await issueApiKey(app, orgA, projectA, { name: "revoke-me", actor: SYSTEM });
      expect(await authenticateApiKey(app, issued.key)).toBeDefined();

      expect(await revokeApiKey(app, orgA, issued.id, { actor: SYSTEM })).toBe(true);
      expect(await revokeApiKey(app, orgA, issued.id, { actor: SYSTEM })).toBe(false);
      expect(await authenticateApiKey(app, issued.key)).toBeUndefined();
      expect(
        await adminCount(
          "SELECT count(*) AS count FROM audit_log WHERE action = 'api_key.revoked' AND target_id = $1",
          [issued.id],
        ),
      ).toBe(1);
    });

    it("cannot revoke another organisation's key", async () => {
      expect(await revokeApiKey(app, orgA, keyB.id, { actor: SYSTEM })).toBe(false);
      expect(await authenticateApiKey(app, keyB.key)).toBeDefined();
    });

    it("cannot be undone, even by code that is allowed to write the column", async () => {
      const issued = await issueApiKey(app, orgA, projectA, { name: "permanent", actor: SYSTEM });
      await revokeApiKey(app, orgA, issued.id, { actor: SYSTEM });

      const error = await rejection(
        withTenant(app, orgA, (client) =>
          client.query("UPDATE api_keys SET revoked_at = NULL WHERE id = $1", [issued.id]),
        ),
      );
      expect(postgresErrorCode(error)).toBe("23000");
      expect(await authenticateApiKey(app, issued.key)).toBeUndefined();
    });
  });

  describe("what the database itself enforces", () => {
    it("does not let the application change a key's secret or project, or delete a key", async () => {
      for (const statement of [
        "UPDATE api_keys SET secret_hash = decode(repeat('00', 32), 'hex')",
        `UPDATE api_keys SET project_id = '${projectA}'`,
        "DELETE FROM api_keys",
      ]) {
        const error = await rejection(withTenant(app, orgA, (client) => client.query(statement)));
        expect(postgresErrorCode(error), statement).toBe("42501");
      }
    });

    it("does not let a key row point at another organisation's project, even written directly", async () => {
      const error = await rejection(
        withTenant(app, orgA, (client) =>
          client.query(
            `INSERT INTO api_keys (organisation_id, project_id, name, secret_hash)
             VALUES ($1, $2, 'direct', decode(repeat('00', 32), 'hex'))`,
            [orgA, projectB],
          ),
        ),
      );
      expect(postgresErrorCode(error)).toBe("23503");
    });

    it("does not let one organisation read or write another's keys", async () => {
      const seen = await withTenant(app, orgA, async (client) => {
        const result = await client.query<{ organisation_id: string }>(
          "SELECT DISTINCT organisation_id FROM api_keys",
        );
        return result.rows.map((row) => row.organisation_id);
      });
      expect(seen).toEqual([orgA]);

      const forged = await rejection(
        withTenant(app, orgA, (client) =>
          client.query(
            `INSERT INTO api_keys (organisation_id, project_id, name, secret_hash)
             VALUES ($1, $2, 'forged', decode(repeat('00', 32), 'hex'))`,
            [orgB, projectB],
          ),
        ),
      );
      expect(postgresErrorCode(forged)).toBe("42501");
    });

    it("follows the tenancy rules in every table, including the new ones", async () => {
      expect(await findSchemaViolations(admin)).toEqual([]);
    });
  });

  describe("the audit log", () => {
    it("records what happened, who did it and what it was about", async () => {
      const actor = { type: "api_key", id: keyA.id } as const;
      const project = await createProject(app, orgA, {
        name: "audited",
        actor,
        requestId: "request-12345678",
      });
      const issued = await issueApiKey(app, orgA, project.id, { name: "audited-key", actor });
      await revokeApiKey(app, orgA, issued.id, { actor });

      const rows = await withTenant(app, orgA, async (client) => {
        const result = await client.query<{
          action: string;
          actor_type: string;
          actor_id: string | null;
          target_type: string | null;
          target_id: string | null;
          request_id: string | null;
          metadata: Record<string, unknown>;
        }>(
          `SELECT action, actor_type, actor_id, target_type, target_id, request_id, metadata
             FROM audit_log
            WHERE actor_id = $1 AND action <> 'organisation.created'
            ORDER BY occurred_at`,
          [keyA.id],
        );
        return result.rows;
      });

      expect(rows).toEqual([
        {
          action: "project.created",
          actor_type: "api_key",
          actor_id: keyA.id,
          target_type: "project",
          target_id: project.id,
          request_id: "request-12345678",
          metadata: {},
        },
        {
          action: "api_key.issued",
          actor_type: "api_key",
          actor_id: keyA.id,
          target_type: "api_key",
          target_id: issued.id,
          request_id: null,
          metadata: { projectId: project.id },
        },
        {
          action: "api_key.revoked",
          actor_type: "api_key",
          actor_id: keyA.id,
          target_type: "api_key",
          target_id: issued.id,
          request_id: null,
          metadata: {},
        },
      ]);
    });

    it("records the creation of an organisation as the platform itself", async () => {
      const row = await withTenant(app, orgA, async (client) => {
        const result = await client.query<{
          actor_type: string;
          actor_id: string | null;
          target_id: string;
        }>(
          "SELECT actor_type, actor_id, target_id FROM audit_log WHERE action = 'organisation.created'",
        );
        return only(result.rows);
      });
      expect(row).toEqual({ actor_type: "system", actor_id: null, target_id: orgA });
    });

    it("shows each organisation only its own entries", async () => {
      for (const org of [orgA, orgB]) {
        const seen = await withTenant(app, org, async (client) => {
          const result = await client.query<{ organisation_id: string }>(
            "SELECT DISTINCT organisation_id FROM audit_log",
          );
          return result.rows.map((row) => row.organisation_id);
        });
        expect(seen).toEqual([org]);
      }
    });

    it("rejects an entry written for another organisation", async () => {
      const error = await rejection(
        withTenant(app, orgA, (client) =>
          client.query(
            `INSERT INTO audit_log (organisation_id, actor_type, action)
             VALUES ($1, 'system', 'project.created')`,
            [orgB],
          ),
        ),
      );
      expect(postgresErrorCode(error)).toBe("42501");
    });

    it("cannot be updated, deleted or truncated by the application", async () => {
      for (const statement of [
        "UPDATE audit_log SET action = 'api_key.revoked'",
        "DELETE FROM audit_log",
        "TRUNCATE audit_log",
      ]) {
        const error = await rejection(withTenant(app, orgA, (client) => client.query(statement)));
        expect(postgresErrorCode(error), statement).toBe("42501");
      }
    });

    it("cannot be updated, deleted or truncated even by the privileged role", async () => {
      const before = await adminCount("SELECT count(*) AS count FROM audit_log");
      for (const statement of [
        "UPDATE audit_log SET action = 'api_key.revoked'",
        "DELETE FROM audit_log",
        "TRUNCATE audit_log",
      ]) {
        const error = await rejection(admin.query(statement));
        expect(postgresErrorCode(error), statement).toBe("23000");
      }
      expect(await adminCount("SELECT count(*) AS count FROM audit_log")).toBe(before);
    });

    it.each([
      [
        "an action that is not in the expected form",
        "INSERT INTO audit_log (organisation_id, actor_type, action) VALUES ($1, 'system', 'Not An Action')",
      ],
      [
        "an action that is too long",
        `INSERT INTO audit_log (organisation_id, actor_type, action) VALUES ($1, 'system', '${"a".repeat(60)}.${"b".repeat(60)}')`,
      ],
      [
        "an unknown actor type",
        "INSERT INTO audit_log (organisation_id, actor_type, action) VALUES ($1, 'robot', 'project.created')",
      ],
      [
        "a system actor with an id",
        `INSERT INTO audit_log (organisation_id, actor_type, actor_id, action) VALUES ($1, 'system', '${randomUUID()}', 'project.created')`,
      ],
      [
        "a non-system actor without an id",
        "INSERT INTO audit_log (organisation_id, actor_type, action) VALUES ($1, 'api_key', 'project.created')",
      ],
      [
        "metadata that is not an object",
        "INSERT INTO audit_log (organisation_id, actor_type, action, metadata) VALUES ($1, 'system', 'project.created', '[1]')",
      ],
      [
        "metadata over 4 KiB",
        "INSERT INTO audit_log (organisation_id, actor_type, action, metadata) VALUES ($1, 'system', 'project.created', jsonb_build_object('k', repeat('x', 5000)))",
      ],
    ])("rejects %s", async (_label, statement) => {
      const error = await rejection(
        withTenant(app, orgA, (client) => client.query(statement, [orgA])),
      );
      expect(postgresErrorCode(error)).toBe("23514");
    });

    it("can be written through recordAudit with only the fields it allows", async () => {
      await withTenant(app, orgB, (client) =>
        recordAudit(client, {
          actor: { type: "operator", id: randomUUID() },
          action: "project.created",
          metadata: { reason: "test", attempt: 1, urgent: false, note: null },
        }),
      );
      expect(
        await adminCount(
          "SELECT count(*) AS count FROM audit_log WHERE organisation_id = $1 AND actor_type = 'operator'",
          [orgB],
        ),
      ).toBe(1);
    });
  });
});
