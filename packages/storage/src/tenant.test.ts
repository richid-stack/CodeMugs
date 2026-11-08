import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { TenantContextError } from "./errors.js";
import { withTenant, type TenantClient } from "./tenant.js";

interface Recorded {
  text: string;
  values: unknown[] | undefined;
}

/** A stand-in for a pool that records what is sent, so no database is needed. */
function fakePool(options: { failRollback?: boolean } = {}) {
  const queries: Recorded[] = [];
  const released: unknown[] = [];
  let connects = 0;
  const client = {
    query(text: string, values?: unknown[]): Promise<unknown> {
      queries.push({ text, values });
      if (text === "ROLLBACK" && options.failRollback === true) {
        return Promise.reject(new Error("rollback failed"));
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release(argument?: unknown): void {
      released.push(argument);
    },
  };
  const pool = {
    connect(): Promise<typeof client> {
      connects += 1;
      return Promise.resolve(client);
    },
  } as unknown as Pool;
  return { pool, queries, released, connects: () => connects };
}

describe("withTenant", () => {
  it.each([
    "",
    "not-a-uuid",
    "123",
    "' OR '1'='1",
    `${randomUUID()}'; DROP TABLE projects; --`,
    ` ${randomUUID()}`,
  ])("rejects %j before touching the database", async (value) => {
    const fake = fakePool();
    await expect(withTenant(fake.pool, value, () => Promise.resolve(1))).rejects.toBeInstanceOf(
      TenantContextError,
    );
    expect(fake.connects()).toBe(0);
  });

  it("does not echo a rejected value in the error message", async () => {
    const fake = fakePool();
    const secretLooking = "hunter2-not-a-uuid";
    const error = await withTenant(fake.pool, secretLooking, () => Promise.resolve(1)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TenantContextError);
    expect(String((error as Error).message)).not.toContain(secretLooking);
  });

  it("sets the tenant as a transaction-local setting, then commits and releases normally", async () => {
    const fake = fakePool();
    const organisationId = randomUUID();
    const result = await withTenant(fake.pool, organisationId, async (client) => {
      await client.query("SELECT 1");
      return "done";
    });

    expect(result).toBe("done");
    expect(fake.queries.map((q) => q.text)).toEqual([
      "BEGIN",
      "SELECT set_config('app.organisation_id', $1, true)",
      "SELECT 1",
      "COMMIT",
    ]);
    // The third argument `true` makes the setting transaction-local. The id is a bound
    // parameter, never part of the SQL text.
    expect(fake.queries[1]?.values).toEqual([organisationId]);
    expect(fake.queries.some((q) => q.text.includes(organisationId))).toBe(false);
    expect(fake.released).toEqual([false]);
  });

  it("tells the work which organisation it is acting for", async () => {
    const fake = fakePool();
    const organisationId = randomUUID();
    const seen = await withTenant(fake.pool, organisationId, (client) =>
      Promise.resolve(client.organisationId),
    );
    expect(seen).toBe(organisationId);
  });

  it("rolls back, rethrows the original error and releases when the work fails", async () => {
    const fake = fakePool();
    const failure = new Error("boom");
    await expect(withTenant(fake.pool, randomUUID(), () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    expect(fake.queries.map((q) => q.text)).toContain("ROLLBACK");
    expect(fake.queries.map((q) => q.text)).not.toContain("COMMIT");
    expect(fake.released).toEqual([false]);
  });

  it("discards the connection when the rollback itself fails", async () => {
    const fake = fakePool({ failRollback: true });
    const failure = new Error("boom");
    await expect(withTenant(fake.pool, randomUUID(), () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    expect(fake.released).toEqual([true]);
  });

  it("refuses queries made after the transaction has ended", async () => {
    const fake = fakePool();
    let captured: TenantClient | undefined;
    await withTenant(fake.pool, randomUUID(), (client) => {
      captured = client;
      return Promise.resolve();
    });

    expect(captured).toBeDefined();
    await expect(captured?.query("SELECT 1")).rejects.toBeInstanceOf(TenantContextError);
    expect(fake.queries.filter((q) => q.text === "SELECT 1")).toHaveLength(0);
  });
});
