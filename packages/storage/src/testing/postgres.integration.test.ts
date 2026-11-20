import { describe, expect, it } from "vitest";
import { adminDatabaseUrl, createTestDatabase, withSetupLock } from "./postgres.js";

const describeDatabase = adminDatabaseUrl() === undefined ? describe.skip : describe;

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** A promise that is settled from the outside, so a test can wait for a moment it chooses. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Test files run in parallel and share two roles, and two changes to one role at once fail with
// "tuple concurrently updated". An advisory lock belongs to one database: sessions connected to
// different databases do not exclude each other. The canary in isolation.integration.test.ts took
// this lock in its own database, so it excluded nothing, and it failed in CI (once in many runs).
describeDatabase("the setup lock", () => {
  it("is taken on the database the server was configured with, whichever database the caller uses", async () => {
    const configured = new URL(adminDatabaseUrl() ?? "").pathname.slice(1);

    const held = await withSetupLock(async (client) => {
      const result = await client.query<{ name: string }>("SELECT current_database() AS name");
      return result.rows[0]?.name;
    });

    expect(held).toBe(configured);
  });

  it("keeps a new test database from being set up while it is held", async () => {
    const locked = deferred();
    const release = deferred();
    const holder = withSetupLock(async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    let setup: ReturnType<typeof createTestDatabase> | undefined;
    try {
      let settled = false;
      setup = createTestDatabase({ migrate: false });
      void setup.then(
        () => (settled = true),
        () => (settled = true),
      );
      // Setting up takes a few tens of milliseconds when nothing holds the lock.
      await pause(500);
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await holder;
    }
    const database = await setup;
    await database.drop();
  });

  it("lets one holder in at a time", async () => {
    const events: string[] = [];
    const firstIn = deferred();
    const first = withSetupLock(async () => {
      events.push("first in");
      firstIn.resolve();
      await pause(200);
      events.push("first out");
    });
    await firstIn.promise;
    const second = withSetupLock(() => {
      events.push("second in");
      return Promise.resolve();
    });

    await Promise.all([first, second]);

    expect(events).toEqual(["first in", "first out", "second in"]);
  });

  it("gives the lock back when what it runs fails, and passes the failure on", async () => {
    await expect(withSetupLock(() => Promise.reject(new Error("the work failed")))).rejects.toThrow(
      "the work failed",
    );

    // If the lock had not been given back this would wait for ever.
    const next = await Promise.race([
      withSetupLock(() => Promise.resolve("got it")),
      pause(3000).then(() => "still waiting"),
    ]);
    expect(next).toBe("got it");
  });
});
