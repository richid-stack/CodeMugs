import { randomUUID } from "node:crypto";
import { createPool, withTenant } from "@codemugs/storage";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { JobFailure } from "./errors.js";
import { claimJobs, completeJob, enqueueJob } from "./queue.js";
import { describeDatabase, startHarness, waitFor, type Harness } from "./test-harness.js";
import { runWorker, type JobHandler, type WorkerEvent, type WorkerOptions } from "./worker.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise that a test resolves by hand, to hold a handler in the middle of its work. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describeDatabase("the worker", () => {
  let h: Harness;
  let orgA: string;
  let orgB: string;
  const started: Array<{ controller: AbortController; done: Promise<void> }> = [];

  beforeAll(async () => {
    h = await startHarness();
    orgA = await h.createOrganisation("A");
    orgB = await h.createOrganisation("B");
  }, 60_000);

  afterEach(async () => {
    for (const { controller, done } of started.splice(0)) {
      controller.abort();
      await done;
    }
  });

  afterAll(async () => {
    await h.close();
  });

  const uniqueKind = (): string => `k${randomUUID().replaceAll("-", "").slice(0, 12)}`;

  /** Starts a worker that retries at once and polls quickly, so tests do not wait on timers. */
  function startWorker(
    handlers: Record<string, JobHandler>,
    options: Partial<WorkerOptions> = {},
  ): { events: WorkerEvent[]; stop: () => Promise<void>; done: Promise<void> } {
    const controller = new AbortController();
    const events: WorkerEvent[] = [];
    const done = runWorker({
      dispatcher: h.dispatcher,
      app: h.app,
      handlers,
      signal: controller.signal,
      concurrency: 2,
      pollIntervalMs: 20,
      backoff: { baseSeconds: 0, maxSeconds: 0 },
      onEvent: (event) => events.push(event),
      ...options,
    });
    started.push({ controller, done });
    return {
      events,
      done,
      stop: async () => {
        controller.abort();
        await done;
      },
    };
  }

  async function enqueue(
    org: string,
    kind: string,
    maxAttempts?: number,
  ): Promise<{ jobId: string; subjectId: string }> {
    const subjectId = randomUUID();
    const result = await withTenant(h.app, org, (client) =>
      enqueueJob(client, {
        kind,
        subjectId,
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
      }),
    );
    if (result.status !== "enqueued") throw new Error("expected the job to be enqueued");
    return { jobId: result.jobId, subjectId };
  }

  const writeEffect: JobHandler = async (job, { client }) => {
    await client.query(
      "INSERT INTO test_effects (organisation_id, subject_id, attempt) VALUES ($1, $2, $3)",
      [client.organisationId, job.subjectId, job.attempt],
    );
  };

  const statusOf = async (jobId: string): Promise<string> => (await h.job(jobId)).status;
  const waitForStatus = (jobId: string, status: string): Promise<void> =>
    waitFor(`job ${jobId} to be ${status}`, async () => (await statusOf(jobId)) === status);
  /**
   * The database shows a job's new status a moment before the worker reports it to its observer: the
   * worker reports when the call that changed the status returns. A test that looks at the events
   * after it has seen the status has to wait for the event too, or it sometimes looks too early.
   */
  const waitForReport = (
    events: readonly WorkerEvent[],
    jobId: string,
    type: WorkerEvent["type"],
  ) =>
    waitFor(`the worker to report ${type} for job ${jobId}`, () =>
      events.some((event) => event.type === type && "jobId" in event && event.jobId === jobId),
    );

  describe("running jobs", () => {
    it("runs a job in its own tenant and marks it succeeded", async () => {
      const kind = uniqueKind();
      const { jobId, subjectId } = await enqueue(orgA, kind);
      const seen: Array<{ tenant: string; attempt: number; subjectId: string | null }> = [];
      const { events } = startWorker({
        [kind]: async (job, context) => {
          seen.push({
            tenant: context.client.organisationId,
            attempt: job.attempt,
            subjectId: job.subjectId,
          });
          await writeEffect(job, context);
        },
      });
      await waitForStatus(jobId, "succeeded");
      await waitForReport(events, jobId, "succeeded");

      expect(seen).toEqual([{ tenant: orgA, attempt: 1, subjectId }]);
      expect(await h.effects(subjectId)).toBe(1);
      expect(events.map((event) => event.type)).toEqual(["claimed", "succeeded"]);
      expect(events[1]).toEqual({
        type: "succeeded",
        jobId,
        organisationId: orgA,
        kind,
        attempt: 1,
      });
    });

    it("gives a handler only its own tenant's data", async () => {
      const kind = uniqueKind();
      // Effects and jobs of both tenants exist; a handler for A must see A's and nothing of B's.
      const otherKind = uniqueKind();
      await enqueue(orgB, otherKind);
      await enqueue(orgB, otherKind);
      await h.admin.query(
        "INSERT INTO test_effects (organisation_id, subject_id, attempt) VALUES ($1, $2, 1), ($1, $2, 1)",
        [orgB, randomUUID()],
      );
      const { jobId } = await enqueue(orgA, kind);
      let visible: { effectsOfOthers: number; jobsOfOthers: number } | undefined;
      startWorker({
        [kind]: async (_job, { client }) => {
          const others = await client.query<{ effects: string; jobs: string }>(
            `SELECT (SELECT count(*) FROM test_effects WHERE organisation_id <> $1) AS effects,
                    (SELECT count(*) FROM jobs WHERE organisation_id <> $1) AS jobs`,
            [client.organisationId],
          );
          visible = {
            effectsOfOthers: Number(others.rows[0]?.effects),
            jobsOfOthers: Number(others.rows[0]?.jobs),
          };
        },
      });
      await waitForStatus(jobId, "succeeded");
      expect(visible).toEqual({ effectsOfOthers: 0, jobsOfOthers: 0 });
    });

    it("shares jobs of many tenants between workers, running each exactly once", async () => {
      const kind = uniqueKind();
      const orgC = await h.createOrganisation("C");
      const jobs: Array<{ jobId: string; subjectId: string; org: string }> = [];
      for (const org of [orgA, orgB, orgC]) {
        for (let i = 0; i < 15; i += 1) jobs.push({ ...(await enqueue(org, kind)), org });
      }
      const handler: JobHandler = async (job, context) => {
        await sleep(5); // Long enough that workers overlap.
        await writeEffect(job, context);
      };
      const workers = [1, 2, 3].map(() => startWorker({ [kind]: handler }, { concurrency: 3 }));

      await waitFor("all 45 jobs to succeed", async () => {
        const result = await h.admin.query<{ n: string }>(
          "SELECT count(*) AS n FROM jobs WHERE kind = $1 AND status = 'succeeded'",
          [kind],
        );
        return Number(result.rows[0]?.n) === 45;
      });
      for (const { jobId, subjectId } of jobs) {
        expect(await h.effects(subjectId)).toBe(1);
        expect((await h.job(jobId)).attempts).toBe(1);
      }
      // Each effect was written under the tenant the job belongs to.
      const misplaced = await h.admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM test_effects e JOIN jobs j ON j.subject_id = e.subject_id
          WHERE j.kind = $1 AND e.organisation_id <> j.organisation_id`,
        [kind],
      );
      expect(misplaced.rows[0]?.n).toBe("0");
      // Every worker took part, so this did test jobs being shared.
      for (const { events } of workers) {
        await waitFor("each worker to report a job it finished", () =>
          events.some((event) => event.type === "succeeded"),
        );
      }
    });

    it("runs no more jobs at once than its concurrency allows, and uses all of it", async () => {
      const kind = uniqueKind();
      for (let i = 0; i < 9; i += 1) await enqueue(orgA, kind);
      let inFlight = 0;
      let peak = 0;
      // Uneven durations, so slots free up one at a time while others are still busy. If all
      // jobs finished together, a worker that took too many would never be caught.
      const durations = [300, 20, 20, 300, 20, 20, 300, 20, 20];
      let started = 0;
      const { events } = startWorker(
        {
          [kind]: async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await sleep(durations[started++] ?? 20);
            inFlight -= 1;
          },
        },
        { concurrency: 3 },
      );
      await waitFor(
        "nine jobs to finish",
        () => events.filter((e) => e.type === "succeeded").length === 9,
      );
      expect(peak).toBe(3);
    });

    it("only takes jobs of kinds it has a handler for", async () => {
      const mine = uniqueKind();
      const notMine = uniqueKind();
      const ours = await enqueue(orgA, mine);
      const theirs = await enqueue(orgA, notMine);
      startWorker({ [mine]: writeEffect });
      await waitForStatus(ours.jobId, "succeeded");
      await sleep(100);
      expect(await h.job(theirs.jobId)).toMatchObject({ status: "queued", attempts: 0 });
    });

    it("picks up a job that arrives while it is idle", async () => {
      const kind = uniqueKind();
      startWorker({ [kind]: writeEffect });
      await sleep(80);
      const { jobId } = await enqueue(orgA, kind);
      await waitForStatus(jobId, "succeeded");
    });
  });

  describe("failures", () => {
    it("rolls back everything a failed attempt wrote, then runs the job again", async () => {
      const kind = uniqueKind();
      const { jobId, subjectId } = await enqueue(orgA, kind);
      const { events } = startWorker({
        [kind]: async (job, context) => {
          await writeEffect(job, context);
          if (job.attempt === 1) throw new Error("fails after writing");
        },
      });
      await waitForStatus(jobId, "succeeded");
      await waitForReport(events, jobId, "succeeded");

      // The first attempt's write was undone: the effect happened once, not twice.
      expect(await h.effects(subjectId)).toBe(1);
      expect((await h.job(jobId)).attempts).toBe(2);
      expect(events.map((event) => event.type)).toEqual([
        "claimed",
        "retrying",
        "claimed",
        "succeeded",
      ]);
      const attempt = await h.admin.query<{ attempt: number }>(
        "SELECT attempt FROM test_effects WHERE subject_id = $1",
        [subjectId],
      );
      expect(attempt.rows).toEqual([{ attempt: 2 }]);
    });

    it("waits out the pause before trying again", async () => {
      const kind = uniqueKind();
      const { jobId } = await enqueue(orgA, kind);
      let calls = 0;
      const { events } = startWorker(
        {
          [kind]: () => {
            calls += 1;
            return Promise.reject(new Error("fails"));
          },
        },
        { backoff: { baseSeconds: 60, maxSeconds: 600 } },
      );
      await waitFor("the first attempt to fail", () => events.some((e) => e.type === "retrying"));
      await sleep(200);
      expect(calls).toBe(1);
      const row = await h.job(jobId);
      expect(row.status).toBe("queued");
      expect(row.seconds_until_available).toBeGreaterThan(50);
    });

    it("gives up after the last attempt and keeps the job as dead", async () => {
      const kind = uniqueKind();
      const { jobId, subjectId } = await enqueue(orgA, kind, 3);
      const { events } = startWorker({
        [kind]: async (job, context) => {
          await writeEffect(job, context);
          throw new JobFailure("upstream_unavailable");
        },
      });
      await waitForStatus(jobId, "dead");
      await waitForReport(events, jobId, "dead");

      const row = await h.job(jobId);
      expect(row).toMatchObject({
        status: "dead",
        attempts: 3,
        last_error_code: "upstream_unavailable",
      });
      expect(row.finished_at).not.toBeNull();
      expect(await h.effects(subjectId)).toBe(0);
      expect(events.map((event) => event.type)).toEqual([
        "claimed",
        "retrying",
        "claimed",
        "retrying",
        "claimed",
        "dead",
      ]);
    });

    it("does not try again after a failure marked as not retryable", async () => {
      const kind = uniqueKind();
      const { jobId } = await enqueue(orgA, kind);
      let calls = 0;
      startWorker({
        [kind]: () => {
          calls += 1;
          return Promise.reject(new JobFailure("unsupported_input", { retryable: false }));
        },
      });
      await waitForStatus(jobId, "dead");
      await sleep(100);
      expect(calls).toBe(1);
      expect((await h.job(jobId)).last_error_code).toBe("unsupported_input");
    });

    it("stores only a short code: never the message of what went wrong", async () => {
      const kind = uniqueKind();
      const customerValue = `jane.${randomUUID()}@customer.example`;
      const { jobId } = await enqueue(orgA, kind, 1);
      const { events } = startWorker({
        [kind]: () => Promise.reject(new Error(`could not process ${customerValue}`)),
      });
      await waitForStatus(jobId, "dead");

      const row = await h.job(jobId);
      expect(row.last_error_code).toBe("handler_error");
      // Nothing the worker stored or reported repeats the value.
      expect(JSON.stringify(row)).not.toContain(customerValue);
      expect(JSON.stringify(events)).not.toContain(customerValue);
    });

    it("replaces a failure code that is not a short stable word", async () => {
      const kind = uniqueKind();
      const customerValue = `jane.${randomUUID()}@customer.example`;
      const { jobId } = await enqueue(orgA, kind, 1);
      const { events } = startWorker({
        [kind]: () => Promise.reject(new JobFailure(customerValue)),
      });
      await waitForStatus(jobId, "dead");

      expect((await h.job(jobId)).last_error_code).toBe("invalid_failure_code");
      expect(JSON.stringify(events)).not.toContain(customerValue);
    });

    it("records a database error by its SQLSTATE only", async () => {
      const kind = uniqueKind();
      const { jobId } = await enqueue(orgA, kind, 1);
      startWorker({
        [kind]: async (_job, { client }) => {
          await client.query("SELECT 1 / 0");
        },
      });
      await waitForStatus(jobId, "dead");
      expect((await h.job(jobId)).last_error_code).toBe("db_22012");
    });

    it("keeps serving other tenants while one tenant's jobs keep failing", async () => {
      const kind = uniqueKind();
      const poisoned: string[] = [];
      for (let i = 0; i < 4; i += 1) poisoned.push((await enqueue(orgA, kind, 1)).jobId);
      const healthy = await enqueue(orgB, kind);
      startWorker(
        {
          [kind]: async (job, context) => {
            if (context.client.organisationId === orgA) {
              throw new JobFailure("poison", { retryable: false });
            }
            await writeEffect(job, context);
          },
        },
        { concurrency: 1 },
      );
      await waitForStatus(healthy.jobId, "succeeded");
      for (const jobId of poisoned) await waitForStatus(jobId, "dead");
    });
  });

  describe("crashes and lost leases", () => {
    it("recovers a job whose worker died, once its lease has run out", async () => {
      const kind = uniqueKind();
      const { jobId, subjectId } = await enqueue(orgA, kind);
      // A worker takes the job and dies without a word.
      const { jobs } = await claimJobs(h.dispatcher, { kinds: [kind], limit: 1, leaseSeconds: 60 });
      expect(jobs).toHaveLength(1);
      expect(await statusOf(jobId)).toBe("running");

      // While the lease holds, a healthy worker leaves the job alone.
      const { events } = startWorker({ [kind]: writeEffect });
      await sleep(150);
      expect(await statusOf(jobId)).toBe("running");
      expect(await h.effects(subjectId)).toBe(0);

      // When the lease runs out, the job is taken again and finished.
      await h.expire(jobId);
      await waitForStatus(jobId, "succeeded");
      await waitForReport(events, jobId, "succeeded");
      const row = await h.job(jobId);
      expect(row.attempts).toBe(2);
      expect(row.last_error_code).toBe("lease_expired"); // The lost attempt stays on record.
      expect(await h.effects(subjectId)).toBe(1);
      expect(events.filter((event) => event.type === "claimed")).toMatchObject([{ attempt: 2 }]);
    });

    it("reports a job that kept crashing as dead, without running it again", async () => {
      const kind = uniqueKind();
      const { jobId } = await enqueue(orgA, kind, 1);
      await claimJobs(h.dispatcher, { kinds: [kind], limit: 1, leaseSeconds: 60 });
      await h.expire(jobId);
      let calls = 0;
      const { events } = startWorker({
        [kind]: () => {
          calls += 1;
          return Promise.resolve();
        },
      });
      await waitForStatus(jobId, "dead");
      await waitForReport(events, jobId, "dead");
      expect(calls).toBe(0);
      expect(events).toContainEqual({
        type: "dead",
        code: "lease_expired",
        jobId,
        organisationId: orgA,
        kind,
        attempt: 1,
      });
    });

    it("rolls back a run whose lease was taken over, and leaves the job to its new holder", async () => {
      const kind = uniqueKind();
      const { jobId, subjectId } = await enqueue(orgA, kind);
      const inHandler = gate();
      const release = gate();
      const { events } = startWorker(
        {
          [kind]: async (job, context) => {
            await writeEffect(job, context);
            inHandler.open();
            await release.wait;
          },
        },
        { concurrency: 1 },
      );
      await inHandler.wait;

      // The handler is slow. Its lease runs out and another worker takes the job.
      await h.expire(jobId);
      const taken = await claimJobs(h.dispatcher, { kinds: [kind], limit: 1, leaseSeconds: 60 });
      const holder = taken.jobs[0];
      expect(holder).toMatchObject({ jobId, attempt: 2 });

      // The slow handler finishes, and finds it is too late.
      release.open();
      await waitFor("the late run to be turned away", () =>
        events.some((event) => event.type === "lease_lost"),
      );
      expect(await h.effects(subjectId)).toBe(0); // Its write was rolled back.
      expect(await statusOf(jobId)).toBe("running"); // The new holder's job is untouched.

      if (holder === undefined) throw new Error("unreachable");
      await withTenant(h.app, orgA, async (client) => {
        await writeEffect(holder, { client, signal: new AbortController().signal });
        await completeJob(client, holder);
      });
      expect(await h.effects(subjectId)).toBe(1); // Exactly one effect, from the holder.
      expect(await statusOf(jobId)).toBe("succeeded");
    });

    it("tells a handler when its lease has run out, and still lets it finish if nobody took over", async () => {
      const kind = uniqueKind();
      const { jobId } = await enqueue(orgA, kind);
      const observed: { abortedAtStart?: boolean; waitedMs?: number } = {};
      startWorker(
        {
          [kind]: async (_job, { signal }) => {
            observed.abortedAtStart = signal.aborted;
            const begun = Date.now();
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            observed.waitedMs = Date.now() - begun;
          },
        },
        { concurrency: 1, leaseSeconds: 1 },
      );
      await waitForStatus(jobId, "succeeded");
      expect(observed.abortedAtStart).toBe(false);
      expect(observed.waitedMs).toBeGreaterThanOrEqual(900);
      expect((await h.job(jobId)).attempts).toBe(1);
    });
  });

  describe("stopping", () => {
    it("finishes the jobs in progress and takes no more", async () => {
      const kind = uniqueKind();
      const first = await enqueue(orgA, kind);
      const inHandler = gate();
      const release = gate();
      const { stop, done } = startWorker(
        {
          [kind]: async () => {
            inHandler.open();
            await release.wait;
          },
        },
        { concurrency: 1 },
      );
      await inHandler.wait;

      let stopped = false;
      const stopping = stop().then(() => {
        stopped = true;
      });
      await sleep(150);
      expect(stopped).toBe(false); // Still waiting for the job in progress.
      expect(await statusOf(first.jobId)).toBe("running");

      release.open();
      await stopping;
      await done;
      expect(await statusOf(first.jobId)).toBe("succeeded");

      // A stopped worker takes nothing new.
      const later = await enqueue(orgA, kind);
      await sleep(150);
      expect(await h.job(later.jobId)).toMatchObject({ status: "queued", attempts: 0 });
    });

    it("returns at once when told to stop while idle", async () => {
      const kind = uniqueKind();
      const { stop } = startWorker({ [kind]: writeEffect }, { pollIntervalMs: 60_000 });
      await sleep(50);
      const begun = Date.now();
      await stop();
      expect(Date.now() - begun).toBeLessThan(1_000);
    });
  });

  describe("when things go wrong around it", () => {
    it("keeps trying, and reports only a code, while the database cannot be reached", async () => {
      const kind = uniqueKind();
      const unreachable = createPool({
        connectionString: "postgres://nobody@127.0.0.1:1/none",
        connectionTimeoutMs: 100,
      });
      try {
        const { events, stop } = startWorker({ [kind]: writeEffect }, { dispatcher: unreachable });
        await waitFor("two failed attempts to reach the database", () => events.length >= 2);
        await stop();
        expect(events.every((event) => event.type === "error" && event.phase === "claim")).toBe(
          true,
        );
        // The code says what kind of failure it was and nothing about where the database is.
        expect(JSON.stringify(events)).not.toContain("127.0.0.1");
      } finally {
        await unreachable.end();
      }
    });

    it("is not stopped by an observer that throws", async () => {
      const kind = uniqueKind();
      const { jobId } = await enqueue(orgA, kind);
      startWorker(
        { [kind]: writeEffect },
        {
          onEvent: () => {
            throw new Error("a broken log shipper");
          },
        },
      );
      await waitForStatus(jobId, "succeeded");
    });

    it("never lets a handler's own mistake end the process", async () => {
      const kind = uniqueKind();
      const { jobId } = await enqueue(orgA, kind, 1);
      startWorker({
        [kind]: () => {
          throw new TypeError("thrown synchronously, not as a rejected promise");
        },
      });
      await waitForStatus(jobId, "dead");
      expect((await h.job(jobId)).last_error_code).toBe("handler_error");
    });
  });
});
