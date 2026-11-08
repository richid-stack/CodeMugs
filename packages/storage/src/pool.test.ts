import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool } from "./pool.js";

const pools: Pool[] = [];

function pool(options: Parameters<typeof createPool>[0]): Pool {
  const created = createPool(options);
  pools.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

const connectionString = "postgres://nobody@127.0.0.1:1/none";

describe("createPool", () => {
  it("applies safe defaults", () => {
    const { options } = pool({ connectionString });
    expect(options.max).toBe(10);
    expect(options.connectionTimeoutMillis).toBe(5_000);
    expect(options.statement_timeout).toBe(30_000);
    expect(options.idle_in_transaction_session_timeout).toBe(30_000);
  });

  it("lets every limit be overridden", () => {
    const { options } = pool({
      connectionString,
      maxConnections: 3,
      connectionTimeoutMs: 250,
      statementTimeoutMs: 1_000,
      idleInTransactionTimeoutMs: 2_000,
    });
    expect(options.max).toBe(3);
    expect(options.connectionTimeoutMillis).toBe(250);
    expect(options.statement_timeout).toBe(1_000);
    expect(options.idle_in_transaction_session_timeout).toBe(2_000);
  });

  it("reports an error on an idle connection to onError instead of crashing the process", () => {
    const seen: Error[] = [];
    const created = pool({ connectionString, onError: (error) => seen.push(error) });
    const failure = new Error("connection reset");
    created.emit("error", failure);
    expect(seen).toEqual([failure]);
  });

  it("gives up on a database that never answers instead of waiting forever", async () => {
    // A server that accepts the TCP connection and then says nothing, like a hung database.
    const sockets = new Set<Socket>();
    const silent = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
    });
    silent.listen(0, "127.0.0.1");
    await once(silent, "listening");
    const address = silent.address();
    if (address === null || typeof address === "string") throw new Error("no port");

    const created = pool({
      connectionString: `postgres://nobody@127.0.0.1:${address.port}/none`,
      connectionTimeoutMs: 200,
    });
    try {
      const started = Date.now();
      await expect(created.query("SELECT 1")).rejects.toThrow(/timeout/i);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      silent.close();
    }
  });
});
