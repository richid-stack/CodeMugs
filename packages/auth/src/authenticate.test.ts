import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Pool } from "@codemugs/storage";
import { describe, expect, it } from "vitest";
import { generateApiKey } from "./apiKey.js";
import { authenticateApiKey } from "./identity.js";

/** A pool whose database holds one key, with the scopes that the test says. */
function poolHolding(
  organisationId: string,
  generated: ReturnType<typeof generateApiKey>,
  scopes: unknown,
) {
  const projectId = randomUUID();
  const client = Object.assign(new EventEmitter(), {
    query: (text: string) =>
      Promise.resolve(
        text.includes("FROM api_keys")
          ? {
              rows: [
                {
                  organisation_id: organisationId,
                  project_id: projectId,
                  secret_hash: generated.secretHash,
                  revoked_at: null,
                  scopes,
                },
              ],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 },
      ),
    release: () => undefined,
  });
  return { pool: { connect: () => Promise.resolve(client) } as unknown as Pool, projectId };
}

describe("authenticating a key, with what the database gives", () => {
  const organisationId = randomUUID();
  const generated = generateApiKey(organisationId);

  it("never gives a scope that the code does not know", async () => {
    const { pool } = poolHolding(organisationId, generated, [
      "billing:admin",
      "analysis:read",
      "events:write",
    ]);
    expect((await authenticateApiKey(pool, generated.key))?.scopes).toEqual([
      "events:write",
      "analysis:read",
    ]);
  });

  it.each([[null], [undefined], ["events:write"], [42], [{}], [[]]])(
    "gives no scopes for %j, rather than guessing",
    async (stored) => {
      const { pool } = poolHolding(organisationId, generated, stored);
      const principal = await authenticateApiKey(pool, generated.key);
      expect(principal?.scopes).toEqual([]);
    },
  );
});
