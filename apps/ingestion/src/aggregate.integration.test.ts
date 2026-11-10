import { randomUUID } from "node:crypto";
import { createOrganisation, createProject, issueApiKey } from "@codemugs/auth";
import {
  claimJobs,
  enqueueJob,
  requeueJob,
  runWorker,
  type JobHandler,
  type WorkerEvent,
} from "@codemugs/jobs";
import { createPool, withTenant, type Pool } from "@codemugs/storage";
import { adminDatabaseUrl, createTestDatabase, type TestDatabase } from "@codemugs/storage/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  aggregateEvents,
  aggregateEventsHandler,
  EVENTS_AGGREGATE_KIND,
  projectLockKey,
} from "./aggregate.js";
import { recordEvents, type IngestScope } from "./record.js";

const describeDatabase = adminDatabaseUrl() === undefined ? describe.skip : describe;
const SYSTEM = { type: "system" } as const;
const DAY = "2026-03-01";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** An event that happened at the given time, on a fixed day in the past. */
function eventAt(time: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    type: "checkout.completed",
    occurredAt: time.includes("T")
      ? time
      : `${DAY}T${/^\d\d:\d\d$/.test(time) ? `${time}:00` : time}Z`,
    environment: "production",
    sdk: { name: "sdk-js", version: "1.2.3" },
    attributes: { orderId: "o-1" },
    ...overrides,
  };
}

const hour = (time: string): string => `${DAY}T${time}:00:00.000Z`;

describeDatabase("processing events into hourly counts", () => {
  const cleanup: Array<() => Promise<void>> = [];
  const workers: Array<{ controller: AbortController; done: Promise<void> }> = [];
  let database: TestDatabase;
  let app: Pool;
  let dispatcher: Pool;
  let admin: Pool;
  let orgA: string;
  let orgB: string;

  async function newScope(organisationId: string): Promise<IngestScope> {
    const projectId = (
      await createProject(app, organisationId, {
        name: `p-${randomUUID().slice(0, 8)}`,
        actor: SYSTEM,
      })
    ).id;
    const key = await issueApiKey(app, organisationId, projectId, { name: "k", actor: SYSTEM });
    return { organisationId, projectId, apiKeyId: key.id };
  }

  /** Stores the events through the real ingestion path and returns the batch they arrived in. */
  async function ingest(scope: IngestScope, events: unknown[]): Promise<string> {
    const outcome = await recordEvents(app, scope, { events });
    if (!outcome.ok || outcome.result.accepted === 0) throw new Error("nothing was stored");
    const first = outcome.result.results[0];
    if (first === undefined || first.eventId === undefined) throw new Error("no event id");
    const row = await admin.query<{ batch_id: string }>(
      "SELECT batch_id FROM events WHERE organisation_id = $1 AND project_id = $2 AND event_id = $3",
      [scope.organisationId, scope.projectId, first.eventId],
    );
    const batchId = row.rows[0]?.batch_id;
    if (batchId === undefined) throw new Error("the event has no batch");
    return batchId;
  }

  /** What the processing job has written for a project: start of hour -> count. */
  async function countsOf(scope: IngestScope): Promise<Record<string, number>> {
    const rows = await admin.query<{ bucket_start: Date; event_count: string }>(
      `SELECT bucket_start, event_count FROM event_aggregates
        WHERE organisation_id = $1 AND project_id = $2 ORDER BY bucket_start`,
      [scope.organisationId, scope.projectId],
    );
    return Object.fromEntries(
      rows.rows.map((row) => [row.bucket_start.toISOString(), Number(row.event_count)]),
    );
  }

  const process = (scope: IngestScope, batchId: string): Promise<number> =>
    withTenant(app, scope.organisationId, (client) => aggregateEvents(client, batchId));

  async function jobOfBatch(scope: IngestScope, batchId: string) {
    const result = await admin.query<{
      id: string;
      status: string;
      attempts: number;
      last_error_code: string | null;
    }>(
      `SELECT id, status, attempts, last_error_code FROM jobs
        WHERE organisation_id = $1 AND kind = $2 AND subject_id = $3`,
      [scope.organisationId, EVENTS_AGGREGATE_KIND, batchId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("no job for the batch");
    return row;
  }

  async function waitFor(what: string, condition: () => Promise<boolean> | boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(25);
    }
  }

  const waitForStatus = (scope: IngestScope, batchId: string, status: string): Promise<void> =>
    waitFor(`the job for the batch to be ${status}`, async () => {
      return (await jobOfBatch(scope, batchId)).status === status;
    });

  function startWorker(
    handlers: Record<string, JobHandler> = { [EVENTS_AGGREGATE_KIND]: aggregateEventsHandler },
    options: { concurrency?: number; backoffSeconds?: number } = {},
  ): { events: WorkerEvent[] } {
    const controller = new AbortController();
    const events: WorkerEvent[] = [];
    const done = runWorker({
      dispatcher,
      app,
      handlers,
      signal: controller.signal,
      concurrency: options.concurrency ?? 2,
      pollIntervalMs: 20,
      backoff: {
        baseSeconds: options.backoffSeconds ?? 0,
        maxSeconds: options.backoffSeconds ?? 0,
      },
      onEvent: (event) => events.push(event),
    });
    workers.push({ controller, done });
    return { events };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    cleanup.unshift(() => database.drop());
    app = createPool({ connectionString: database.appUrl, maxConnections: 10 });
    cleanup.unshift(() => app.end());
    dispatcher = createPool({ connectionString: database.dispatcherUrl, maxConnections: 4 });
    cleanup.unshift(() => dispatcher.end());
    admin = createPool({ connectionString: database.adminUrl, maxConnections: 2 });
    cleanup.unshift(() => admin.end());
    orgA = (await createOrganisation(app, { name: "A" })).id;
    orgB = (await createOrganisation(app, { name: "B" })).id;
  }, 60_000);

  afterEach(async () => {
    for (const { controller, done } of workers.splice(0)) {
      controller.abort();
      await done;
    }
  });

  afterAll(async () => {
    for (const close of cleanup) await close();
  });

  describe("aggregateEvents", () => {
    it("counts events per UTC hour by the time they happened, not the time they arrived", async () => {
      const scope = await newScope(orgA);
      const batch = await ingest(scope, [
        eventAt("09:59:59.999"),
        eventAt("10:00:00.000"),
        eventAt("10:30:00"),
        eventAt("10:59:59.999"),
        eventAt("11:00:00.000"),
      ]);
      expect(await process(scope, batch)).toBe(3);
      expect(await countsOf(scope)).toEqual({ [hour("09")]: 1, [hour("10")]: 3, [hour("11")]: 1 });
    });

    it("reads a time written with an offset as the UTC hour it falls in", async () => {
      const scope = await newScope(orgA);
      const batch = await ingest(scope, [
        eventAt(`${DAY}T12:30:00+02:00`),
        eventAt(`${DAY}T16:00:00+05:30`),
      ]);
      await process(scope, batch);
      expect(await countsOf(scope)).toEqual({ [hour("10")]: 2 });
    });

    it("counts every batch's events in an hour, so a later batch brings the count up to date", async () => {
      const scope = await newScope(orgA);
      const first = await ingest(scope, [eventAt("10:01"), eventAt("10:02"), eventAt("10:03")]);
      await process(scope, first);
      expect(await countsOf(scope)).toEqual({ [hour("10")]: 3 });

      const late = await ingest(scope, [eventAt("10:04"), eventAt("10:05")]);
      await process(scope, late);
      expect(await countsOf(scope)).toEqual({ [hour("10")]: 5 });

      // Batches may be processed in any order, and again: the count is the number of events.
      await process(scope, first);
      await process(scope, late);
      expect(await countsOf(scope)).toEqual({ [hour("10")]: 5 });
    });

    it("gives the same rows however many times it runs", async () => {
      const scope = await newScope(orgA);
      const batch = await ingest(scope, [eventAt("08:10"), eventAt("08:20"), eventAt("09:05")]);
      for (let run = 0; run < 3; run += 1) await process(scope, batch);
      expect(await countsOf(scope)).toEqual({ [hour("08")]: 2, [hour("09")]: 1 });
    });

    it("keeps one project's counts apart from another's, in the same organisation", async () => {
      const one = await newScope(orgA);
      const two = await newScope(orgA);
      const batchOne = await ingest(one, [eventAt("10:01"), eventAt("10:02")]);
      const batchTwo = await ingest(two, [eventAt("10:03")]);
      await process(one, batchOne);
      await process(two, batchTwo);
      expect(await countsOf(one)).toEqual({ [hour("10")]: 2 });
      expect(await countsOf(two)).toEqual({ [hour("10")]: 1 });
    });

    it("never counts or writes across tenants", async () => {
      const mine = await newScope(orgA);
      const theirs = await newScope(orgB);
      const myBatch = await ingest(mine, [eventAt("10:01")]);
      const theirBatch = await ingest(theirs, [eventAt("10:02"), eventAt("10:03")]);

      await process(mine, myBatch);
      expect(await countsOf(mine)).toEqual({ [hour("10")]: 1 });
      expect(await countsOf(theirs)).toEqual({});

      // Another tenant's batch id, used under this tenant: those events are not visible to it.
      expect(await process(mine, theirBatch)).toBe(0);
      expect(await countsOf(theirs)).toEqual({});
      expect(await countsOf(mine)).toEqual({ [hour("10")]: 1 });
    });

    it("writes nothing for a batch that does not exist", async () => {
      const scope = await newScope(orgA);
      expect(await process(scope, randomUUID())).toBe(0);
      expect(await countsOf(scope)).toEqual({});
    });

    it("counts a batch that spans projects, each in its own project", async () => {
      const one = await newScope(orgA);
      const two = await newScope(orgA);
      const batch = await ingest(one, [eventAt("10:01"), eventAt("10:02")]);
      const other = await ingest(two, [eventAt("10:03")]);
      // Ingestion puts one project in a batch; the handler does not rely on that.
      await admin.query(
        "UPDATE events SET batch_id = $1 WHERE organisation_id = $2 AND batch_id = $3",
        [batch, orgA, other],
      );
      expect(await process(one, batch)).toBe(2);
      expect(await countsOf(one)).toEqual({ [hour("10")]: 2 });
      expect(await countsOf(two)).toEqual({ [hour("10")]: 1 });
    });

    it("waits for the project's lock before it counts, so it counts what committed while it waited", async () => {
      const scope = await newScope(orgA);
      const first = await ingest(scope, [eventAt("10:01"), eventAt("10:02"), eventAt("10:03")]);

      // Another handler for the project is in progress: it holds the project's lock.
      const holder = await admin.connect();
      let locked = false;
      try {
        await holder.query("SELECT pg_advisory_lock(hashtextextended($1::text, 0))", [
          projectLockKey(scope.projectId),
        ]);
        locked = true;

        let done = false;
        const run = process(scope, first).then(() => {
          done = true;
        });
        await sleep(300);
        expect(done).toBe(false);
        expect(await countsOf(scope)).toEqual({});

        // Two more events commit while it waits. It has not counted yet, so it will see them.
        await ingest(scope, [eventAt("10:04"), eventAt("10:05")]);

        await holder.query("SELECT pg_advisory_unlock(hashtextextended($1::text, 0))", [
          projectLockKey(scope.projectId),
        ]);
        locked = false;
        await run;
        expect(await countsOf(scope)).toEqual({ [hour("10")]: 5 });
      } finally {
        if (locked) {
          await holder.query("SELECT pg_advisory_unlock_all()");
        }
        holder.release();
      }
    });

    it("does not make handlers for different projects wait for each other", async () => {
      const one = await newScope(orgA);
      const two = await newScope(orgA);
      const batchOne = await ingest(one, [eventAt("10:01")]);
      const batchTwo = await ingest(two, [eventAt("10:02")]);

      const counted = gate();
      const release = gate();
      const slow = withTenant(app, orgA, async (client) => {
        await aggregateEvents(client, batchOne);
        counted.open();
        await release.wait;
      });
      await counted.wait;
      await process(two, batchTwo); // Returns without waiting for the first to commit.
      expect(await countsOf(two)).toEqual({ [hour("10")]: 1 });
      release.open();
      await slow;
    });
  });

  describe("with a worker", () => {
    it("turns ingested batches into counts, for every tenant, and finishes their jobs", async () => {
      const a = await newScope(orgA);
      const b = await newScope(orgB);
      const batches: Array<[IngestScope, string]> = [];
      batches.push([a, await ingest(a, [eventAt("10:01"), eventAt("10:02")])]);
      batches.push([a, await ingest(a, [eventAt("10:03"), eventAt("11:00")])]);
      batches.push([a, await ingest(a, [eventAt("09:59")])]);
      batches.push([b, await ingest(b, [eventAt("10:05")])]);
      batches.push([b, await ingest(b, [eventAt("10:06"), eventAt("10:07")])]);

      startWorker(undefined, { concurrency: 3 });
      for (const [scope, batch] of batches) await waitForStatus(scope, batch, "succeeded");

      expect(await countsOf(a)).toEqual({ [hour("09")]: 1, [hour("10")]: 3, [hour("11")]: 1 });
      expect(await countsOf(b)).toEqual({ [hour("10")]: 3 });
      for (const [scope, batch] of batches) {
        expect(await jobOfBatch(scope, batch)).toMatchObject({
          attempts: 1,
          last_error_code: null,
        });
      }
    });

    it("recovers a batch whose worker died, once its lease has run out", async () => {
      const scope = await newScope(orgA);
      const batch = await ingest(scope, [eventAt("10:01"), eventAt("10:02")]);
      const job = await jobOfBatch(scope, batch);

      // A worker takes the job and dies without a word.
      const taken = await claimJobs(dispatcher, {
        kinds: [EVENTS_AGGREGATE_KIND],
        limit: 100,
        leaseSeconds: 60,
      });
      expect(taken.jobs.map((claimed) => claimed.jobId)).toContain(job.id);

      startWorker();
      await sleep(200);
      expect((await jobOfBatch(scope, batch)).status).toBe("running"); // The lease still holds.
      expect(await countsOf(scope)).toEqual({});

      await admin.query(
        "UPDATE jobs SET available_at = now() - interval '1 second' WHERE id = $1",
        [job.id],
      );
      await waitForStatus(scope, batch, "succeeded");
      expect(await countsOf(scope)).toEqual({ [hour("10")]: 2 });
      expect(await jobOfBatch(scope, batch)).toMatchObject({
        attempts: 2,
        last_error_code: "lease_expired",
      });
    });

    it("leaves no counts behind from an attempt that failed, and gets them right on the next", async () => {
      const scope = await newScope(orgA);
      const batch = await ingest(scope, [eventAt("10:01"), eventAt("10:02"), eventAt("10:03")]);
      const job = await jobOfBatch(scope, batch);
      const { events } = startWorker(
        {
          [EVENTS_AGGREGATE_KIND]: async (claimed, context) => {
            await aggregateEventsHandler(claimed, context);
            if (claimed.attempt === 1) throw new Error("fails after counting");
          },
        },
        { backoffSeconds: 3_600 }, // The retry waits, so the state in between can be looked at.
      );
      await waitFor("the first attempt to fail", () => events.some((e) => e.type === "retrying"));

      // The handler had counted, but its transaction was rolled back: nothing is stored.
      expect(await countsOf(scope)).toEqual({});
      expect((await jobOfBatch(scope, batch)).status).toBe("queued");

      await admin.query(
        "UPDATE jobs SET available_at = now() - interval '1 second' WHERE id = $1",
        [job.id],
      );
      await waitForStatus(scope, batch, "succeeded");
      expect(await countsOf(scope)).toEqual({ [hour("10")]: 3 });
      expect((await jobOfBatch(scope, batch)).attempts).toBe(2);
    });

    it("can be replayed: running a finished batch again restores counts that were lost or wrong", async () => {
      const scope = await newScope(orgA);
      const batch = await ingest(scope, [eventAt("10:01"), eventAt("10:02"), eventAt("11:03")]);
      startWorker();
      await waitForStatus(scope, batch, "succeeded");
      const correct = { [hour("10")]: 2, [hour("11")]: 1 };
      expect(await countsOf(scope)).toEqual(correct);

      // Damage the derived data, as a bug or a restore from an old backup might.
      await admin.query("UPDATE event_aggregates SET event_count = 999 WHERE project_id = $1", [
        scope.projectId,
      ]);
      await admin.query(
        "DELETE FROM event_aggregates WHERE project_id = $1 AND bucket_start = $2",
        [scope.projectId, hour("11")],
      );
      expect(await countsOf(scope)).not.toEqual(correct);

      const replayed = await withTenant(app, orgA, (client) =>
        requeueJob(client, { kind: EVENTS_AGGREGATE_KIND, subjectId: batch }),
      );
      expect(replayed).toBe(true);
      await waitFor("the replay to finish", async () => {
        const counts = await countsOf(scope);
        return (
          (await jobOfBatch(scope, batch)).status === "succeeded" &&
          counts[hour("10")] === 2 &&
          counts[hour("11")] === 1
        );
      });
      expect(await countsOf(scope)).toEqual(correct);
      expect(await jobOfBatch(scope, batch)).toMatchObject({ attempts: 1, last_error_code: null });
    });

    it("gives up on a job with no batch, at once, with a code", async () => {
      const scope = await newScope(orgA);
      const jobId = await withTenant(app, orgA, async (client) => {
        const result = await enqueueJob(client, { kind: EVENTS_AGGREGATE_KIND });
        if (result.status !== "enqueued") throw new Error("expected the job to be enqueued");
        return result.jobId;
      });
      startWorker();
      await waitFor("the job to be dead", async () => {
        const row = await admin.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [
          jobId,
        ]);
        return row.rows[0]?.status === "dead";
      });
      const row = await admin.query<{ attempts: number; last_error_code: string }>(
        "SELECT attempts, last_error_code FROM jobs WHERE id = $1",
        [jobId],
      );
      expect(row.rows[0]).toEqual({ attempts: 1, last_error_code: "missing_batch" });
      expect(await countsOf(scope)).toEqual({});
    });
  });
});
