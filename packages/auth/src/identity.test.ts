import { randomUUID } from "node:crypto";
import type { Pool } from "@codemugs/storage";
import { describe, expect, it } from "vitest";
import { generateApiKey } from "./apiKey.js";
import { IdentityError } from "./errors.js";
import {
  authenticateApiKey,
  createOrganisation,
  createProject,
  issueApiKey,
  revokeApiKey,
} from "./identity.js";

/** A pool that counts connection attempts and then fails, standing in for a database outage. */
function brokenPool() {
  let attempts = 0;
  const pool = {
    connect(): Promise<never> {
      attempts += 1;
      return Promise.reject(new Error("database is down"));
    },
  } as unknown as Pool;
  return { pool, attempts: () => attempts };
}

describe("input that never needs the database", () => {
  it.each([
    ["an empty name", ""],
    ["a 201 character name", "x".repeat(201)],
  ])("rejects %s when creating an organisation or a project", async (_label, name) => {
    const { pool, attempts } = brokenPool();
    await expect(createOrganisation(pool, { name })).rejects.toMatchObject({
      code: "invalid_name",
    });
    await expect(
      createProject(pool, randomUUID(), { name, actor: { type: "system" } }),
    ).rejects.toMatchObject({ code: "invalid_name" });
    expect(attempts()).toBe(0);
  });

  it("rejects a key name that is empty or too long", async () => {
    const { pool, attempts } = brokenPool();
    for (const name of ["", "x".repeat(201)]) {
      await expect(
        issueApiKey(pool, randomUUID(), randomUUID(), { name, actor: { type: "system" } }),
      ).rejects.toMatchObject({ code: "invalid_name" });
    }
    expect(attempts()).toBe(0);
  });

  it("treats a project id that is not a UUID as a project that does not exist", async () => {
    const { pool, attempts } = brokenPool();
    const error = await issueApiKey(pool, randomUUID(), "not-a-uuid", {
      name: "ci",
      actor: { type: "system" },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IdentityError);
    expect((error as IdentityError).code).toBe("project_not_found");
    expect(attempts()).toBe(0);
  });

  it("reports nothing revoked for a key id that is not a UUID", async () => {
    const { pool, attempts } = brokenPool();
    expect(
      await revokeApiKey(pool, randomUUID(), "not-a-uuid", { actor: { type: "system" } }),
    ).toBe(false);
    expect(attempts()).toBe(0);
  });

  it.each(["", "Bearer something", "cmk_short", "x".repeat(5000)])(
    "does not authenticate %j and does not touch the database",
    async (presented) => {
      const { pool, attempts } = brokenPool();
      expect(await authenticateApiKey(pool, presented)).toBeUndefined();
      expect(attempts()).toBe(0);
    },
  );

  it("does not echo a rejected name or id in its error messages", async () => {
    const { pool } = brokenPool();
    const name = "x".repeat(201);
    const error = await createOrganisation(pool, { name }).catch((caught: unknown) => caught);
    expect((error as Error).message).not.toContain(name);
  });
});

describe("a database failure", () => {
  it("throws instead of being reported as 'not authenticated'", async () => {
    const { pool, attempts } = brokenPool();
    const { key } = generateApiKey(randomUUID());
    await expect(authenticateApiKey(pool, key)).rejects.toThrow("database is down");
    expect(attempts()).toBe(1);
  });
});
