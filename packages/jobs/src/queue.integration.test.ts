import { randomUUID } from "node:crypto";
import { withTenant } from "@codemugs/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LeaseLostError } from "./errors.js";
import {
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  requeueJob,
  type ClaimedJob,
} from "./queue.js";
import { describeDatabase, startHarness, type Harness } from "./test-harness.js";

describeDatabase("the job queue", () => {
  let h: Harness;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    h = await startHarness();
    orgA = await h.createOrganisation("A");
    orgB = await h.createOrganisation("B");
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  /** Enqueues a job as the tenant and returns its id, with its own kind so tests stay apart. */
  async function enqueue(
    org: string,
    kind: string,
    extra: { subjectId?: string; maxAttempts?: number } = {},
  ): Promise<string> {
    const result = await withTenant(h.app, org, (client) => enqueueJob(client, { kind, ...extra }));
    if (result.status !== "enqueued") throw new Error("expected the job to be enqueued");
    return result.jobId;
  }

  const uniqueKind = (): string => `k${randomUUID().replaceAll("-", "").slice(0, 12)}`;

  async function claimOne(kind: string, leaseSeconds = 60): Promise<ClaimedJob> {
    const { jobs } = await claimJobs(h.dispatcher, { kinds: [kind], limit: 1, leaseSeconds });
    const [job] = jobs;
    if (jobs.length !== 1 || job === undefined) throw new Error("expected one job to claim");
    return job;
  }

  describe("enqueueJob", () => {
    it("adds a queued job for the organisation the transaction acts for", async () => {
      const kind = uniqueKind();
      const subjectId = randomUUID();
      const jobId = await enqueue(orgA, kind, { subjectId });
      const row = await h.job(jobId);
      expect(row).toMatchObject({
        organisation_id: orgA,
        kind,
        subject_id: subjectId,
        status: "queued",
        attempts: 0,
        max_attempts: 5,
        lease_token: null,
      });
      expect(row.seconds_until_available).toBeLessThanOrEqual(1);
    });

    it("reports a second job for the same subject as existing, in any state", async () => {
      const kind = uniqueKind();
      const subjectId = randomUUID();
      const jobId = await enqueue(orgA, kind, { subjectId });
      const again = (): ReturnType<typeof enqueueJob> =>
        withTenant(h.app, orgA, (client) => enqueueJob(client, { kind, subjectId }));
      expect(await again()).toEqual({ status: "exists" });

      const claimed = await claimOne(kind);
      expect(claimed.jobId).toBe(jobId);
      expect(await again()).toEqual({ status: "exists" });
      await withTenant(h.app, orgA, (client) => completeJob(client, claimed));
      expect(await again()).toEqual({ status: "exists" });

      const count = await h.admin.query<{ n: string }>(
        "SELECT count(*) AS n FROM jobs WHERE kind = $1",
        [kind],
      );
      expect(count.rows[0]?.n).toBe("1");
    });

    it("never treats jobs without a subject as the same job", async () => {
      const kind = uniqueKind();
      const first = await enqueue(orgA, kind);
      const second = await enqueue(orgA, kind);
      expect(second).not.toBe(first);
    });

    it("lets two organisations have a job of the same kind for the same subject id", async () => {
      const kind = uniqueKind();
      const subjectId = randomUUID();
      await enqueue(orgA, kind, { subjectId });
      await expect(enqueue(orgB, kind, { subjectId })).resolves.toBeTypeOf("string");
    });

    it("exists only if the transaction that enqueued it commits", async () => {
      const kind = uniqueKind();
      const subjectId = randomUUID();
      await expect(
        withTenant(h.app, orgA, async (client) => {
          await enqueueJob(client, { kind, subjectId });
          throw new Error("the work failed after the job was enqueued");
        }),
      ).rejects.toThrow("the work failed");
      const count = await h.admin.query<{ n: string }>(
        "SELECT count(*) AS n FROM jobs WHERE kind = $1",
        [kind],
      );
      expect(count.rows[0]?.n).toBe("0");
      // And the same pair can be enqueued afterwards: nothing was left behind.
      await expect(enqueue(orgA, kind, { subjectId })).resolves.toBeTypeOf("string");
    });

    it("takes the organisation from the transaction, not from the caller", async () => {
      const kind = uniqueKind();
      const jobId = await enqueue(orgB, kind);
      expect((await h.job(jobId)).organisation_id).toBe(orgB);
    });
  });

  describe("claimJobs", () => {
    it("takes jobs from every tenant in one call", async () => {
      const kind = uniqueKind();
      const a = await enqueue(orgA, kind);
      const b = await enqueue(orgB, kind);
      const { jobs, abandoned } = await claimJobs(h.dispatcher, {
        kinds: [kind],
        limit: 10,
        leaseSeconds: 60,
      });
      expect(abandoned).toEqual([]);
      expect(jobs.map((job) => job.jobId).sort()).toEqual([a, b].sort());
      expect(jobs.find((job) => job.jobId === a)?.organisationId).toBe(orgA);
      expect(jobs.find((job) => job.jobId === b)?.organisationId).toBe(orgB);
    });

    it("takes only the kinds it is asked for", async () => {
      const wanted = uniqueKind();
      const other = uniqueKind();
      const otherId = await enqueue(orgA, other);
      await enqueue(orgA, wanted);
      const { jobs } = await claimJobs(h.dispatcher, {
        kinds: [wanted],
        limit: 10,
        leaseSeconds: 60,
      });
      expect(jobs.map((job) => job.kind)).toEqual([wanted]);
      expect((await h.job(otherId)).status).toBe("queued");
    });

    it("takes no more than the limit, oldest first", async () => {
      const kind = uniqueKind();
      // Inserted in one order, made due in another, so the answer cannot be the insert order.
      const inserted = [
        await enqueue(orgA, kind),
        await enqueue(orgA, kind),
        await enqueue(orgA, kind),
        await enqueue(orgA, kind),
      ] as const;
      const [newest, oldest, middle, latest] = inserted;
      for (const [id, seconds] of [
        [newest, 1],
        [oldest, 30],
        [middle, 20],
        [latest, 2],
      ] as const) {
        await h.admin.query(
          "UPDATE jobs SET available_at = now() - make_interval(secs => $2) WHERE id = $1",
          [id, seconds],
        );
      }
      const { jobs } = await claimJobs(h.dispatcher, { kinds: [kind], limit: 2, leaseSeconds: 60 });
      expect(jobs.map((job) => job.jobId)).toEqual([oldest, middle]);
    });

    it("does not wait for a job that another worker is in the middle of taking", async () => {
      const kind = uniqueKind();
      const busy = await enqueue(orgA, kind);
      const free = await enqueue(orgB, kind);
      await h.admin.query(
        "UPDATE jobs SET available_at = now() - interval '10 seconds' WHERE id = $1",
        [busy],
      );
      // Another worker's transaction has the row locked and has not finished.
      const other = await h.admin.connect();
      try {
        await other.query("BEGIN");
        await other.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [busy]);
        const claim = claimJobs(h.dispatcher, { kinds: [kind], limit: 10, leaseSeconds: 60 });
        const outcome = await Promise.race([
          claim,
          new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 3_000)),
        ]);
        await other.query("ROLLBACK");
        expect(outcome).not.toBe("waited");
        if (outcome === "waited") return;
        expect(outcome.jobs.map((job) => job.jobId)).toEqual([free]);
      } finally {
        await other.query("ROLLBACK").catch(() => undefined);
        other.release();
      }
    });

    it("counts the claim as an attempt and holds the job under a lease", async () => {
      const kind = uniqueKind();
      const subjectId = randomUUID();
      const jobId = await enqueue(orgA, kind, { subjectId });
      const claimed = await claimOne(kind, 120);
      expect(claimed).toMatchObject({
        jobId,
        organisationId: orgA,
        kind,
        subjectId,
        attempt: 1,
        maxAttempts: 5,
      });
      const row = await h.job(jobId);
      expect(row.status).toBe("running");
      expect(row.attempts).toBe(1);
      expect(row.lease_token).toBe(claimed.leaseToken);
      // The lease runs for the time asked, measured by the database's clock.
      expect(row.seconds_until_available).toBeGreaterThan(110);
      expect(row.seconds_until_available).toBeLessThanOrEqual(120);
    });

    it("leaves a job alone until its time has come", async () => {
      const kind = uniqueKind();
      const jobId = await enqueue(orgA, kind);
      await h.admin.query(
        "UPDATE jobs SET available_at = now() + interval '1 hour' WHERE id = $1",
        [jobId],
      );
      const { jobs } = await claimJobs(h.dispatcher, {
        kinds: [kind],
        limit: 10,
        leaseSeconds: 60,
      });
      expect(jobs).toEqual([]);
    });

    it("leaves a running job alone while its lease holds", async () => {
      const kind = uniqueKind();
      await enqueue(orgA, kind);
      await claimOne(kind);
      const { jobs } = await claimJobs(h.dispatcher, {
        kinds: [kind],
        limit: 10,
        leaseSeconds: 60,
      });
      expect(jobs).toEqual([]);
    });

    it("never hands the same job to two workers that ask at the same time", async () => {
      const kind = uniqueKind();
      const ids: string[] = [];
      for (let i = 0; i < 40; i += 1) ids.push(await enqueue(i % 2 === 0 ? orgA : orgB, kind));

      const claimedBy: string[][] = Array.from({ length: 8 }, () => []);
      await Promise.all(
        claimedBy.map(async (mine) => {
          for (;;) {
            const { jobs } = await claimJobs(h.dispatcher, {
              kinds: [kind],
              limit: 3,
              leaseSeconds: 60,
            });
            if (jobs.length === 0) return;
            mine.push(...jobs.map((job) => job.jobId));
          }
        }),
      );
      const all = claimedBy.flat();
      expect(all).toHaveLength(40);
      expect(new Set(all).size).toBe(40);
      expect([...all].sort()).toEqual([...ids].sort());
      // Work was actually shared, so the test did exercise concurrent claims.
      expect(claimedBy.filter((mine) => mine.length > 0).length).toBeGreaterThan(1);
    });

    it("takes a job again when its lease has run out, and counts another attempt", async () => {
      const kind = uniqueKind();
      const jobId = await enqueue(orgA, kind);
      const lost = await claimOne(kind);
      await h.expire(jobId);

      const recovered = await claimOne(kind);
      expect(recovered.jobId).toBe(jobId);
      expect(recovered.attempt).toBe(2);
      expect(recovered.leaseToken).not.toBe(lost.leaseToken);
      const row = await h.job(jobId);
      expect(row.status).toBe("running");
      expect(row.last_error_code).toBe("lease_expired");
    });

    it("marks a job dead when its last attempt's lease runs out, and reports it", async () => {
      const kind = uniqueKind();
      const jobId = await enqueue(orgA, kind, { maxAttempts: 2 });
      await claimOne(kind);
      await h.expire(jobId);
      await claimOne(kind); // attempt 2 of 2
      await h.expire(jobId);

      const { jobs, abandoned } = await claimJobs(h.dispatcher, {
        kinds: [kind],
        limit: 10,
        leaseSeconds: 60,
      });
      expect(jobs).toEqual([]);
      expect(abandoned).toEqual([{ jobId, organisationId: orgA, kind, attempts: 2 }]);
      const row = await h.job(jobId);
      expect(row).toMatchObject({
        status: "dead",
        attempts: 2,
        lease_token: null,
        last_error_code: "lease_expired",
      });
      expect(row.finished_at).not.toBeNull();

      // Reported once: the next claim does not find it again.
      const next = await claimJobs(h.dispatcher, { kinds: [kind], limit: 10, leaseSeconds: 60 });
      expect(next.abandoned).toEqual([]);
    });

    it("finishes off an exhausted job even when the worker has no handler for its kind", async () => {
      const kind = uniqueKind();
      const jobId = await enqueue(orgA, kind, { maxAttempts: 1 });
      await claimOne(kind);
      await h.expire(jobId);
      const { abandoned } = await claimJobs(h.dispatcher, {
        kinds: [uniqueKind()],
        limit: 1,
        leaseSeconds: 60,
      });
      expect(abandoned.map((job) => job.jobId)).toContain(jobId);
    });
  });

  describe("completeJob", () => {
    it("marks the job succeeded and clears the lease", async () => {
      const kind = uniqueKind();
      const jobId = await enqueue(orgA, kind);
      const claimed = await claimOne(kind);
      await withTenant(h.app, orgA, (client) => completeJob(client, claimed));
      const row = await h.job(jobId);
      expect(row).toMatchObject({ status: "succeeded", lease_token: null, attempts: 1 });
      expect(row.finished_at).not.toBeNull();
    });

    it("cannot finish a job a second time", async () => {
      const kind = uniqueKind();
      await enqueue(orgA, kind);
      const claimed = await claimOne(kind);
      await withTenant(h.app, orgA, (client) => completeJob(client, claimed));
      await expect(
        withTenant(h.app, orgA, (client) => completeJob(client, claimed)),
      ).rejects.toBeInstanceOf(LeaseLostError);
    });

    it("refuses a worker whose lease was taken over, and lets the new holder finish", async () => {
      const kind = uniqueKind();
      const jobId = await enqueue(orgA, kind);
      const zombie = await claimOne(kind);
      await h.expire(jobId);
      const holder = await claimOne(kind);

      await expect(
        withTenant(h.app, orgA, (client) => completeJob(client, zombie)),
      ).rejects.toBeInstanceOf(LeaseLostError);
      expect((await h.job(jobId)).status).toBe("running");

      await withTenant(h.app, orgA, (client) => completeJob(client, holder));
      expect((await h.job(jobId)).status).toBe("succeeded");
    });

    it("lets a worker whose lease ran out finish if nobody took the job over", async () => {
      const kind = uniqueKind();
      const jobId = await enqueue(orgA, kind);
      const slow = await claimOne(kind);
      await h.expire(jobId);
      await withTenant(h.app, orgA, (client) => completeJob(client, slow));
      expect((await h.job(jobId)).status).toBe("succeeded");
    });

    it("cannot be done by another tenant, even with the right token", async () => {
      const kind = uniqueKind();
      const jobId = await enqueue(orgA, kind);
      const claimed = await claimOne(kind);
      await expect(
        withTenant(h.app, orgB, (client) => completeJob(client, claimed)),
      ).rejects.toBeInstanceOf(LeaseLostError);
      expect((await h.job(jobId)).status).toBe("running");
    });

    it("commits with the work it is done in, and not without it", async () => {
      const kind = uniqueKind();
      const subjectId = randomUUID();
      const jobId = await enqueue(orgA, kind, { subjectId });
      const claimed = await claimOne(kind);
      const write = (client: { query: (sql: string, values: unknown[]) => Promise<unknown> }) =>
        client.query(
          "INSERT INTO test_effects (organisation_id, subject_id, attempt) VALUES ($1, $2, 1)",
          [orgA, subjectId],
        );

      await expect(
        withTenant(h.app, orgA, async (client) => {
          await write(client);
          await completeJob(client, claimed);
          throw new Error("the commit never happens");
        }),
      ).rejects.toThrow("the commit never happens");
      expect(await h.effects(subjectId)).toBe(0);
      expect((await h.job(jobId)).status).toBe("running");

      await withTenant(h.app, orgA, async (client) => {
        await write(client);
        await completeJob(client, claimed);
      });
      expect(await h.effects(subjectId)).toBe(1);
      expect((await h.job(jobId)).status).toBe("succeeded");
    });
  });

  describe("failJob", () => {
    const fail = (
      org: string,
      job: ClaimedJob,
      failure: { code: string; retryable: boolean },
      backoff = { baseSeconds: 10, maxSeconds: 25 },
    ): Promise<string> =>
      withTenant(h.app, org, (client) => failJob(client, job, failure, backoff));

    it("queues the job again after a pause that doubles with each attempt, up to a cap", async () => {
      const kind = uniqueKind();
      const jobId = await enqueue(orgA, kind);
      const pauses: number[] = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await h.admin.query("UPDATE jobs SET available_at = now() WHERE id = $1", [jobId]);
        const claimed = await claimOne(kind);
        expect(claimed.attempt).toBe(attempt);
        expect(await fail(orgA, claimed, { code: "boom", retryable: true })).toBe("retry");
        const row = await h.job(jobId);
        expect(row).toMatchObject({ status: "queued", lease_token: null, last_error_code: "boom" });
        expect(row.finished_at).toBeNull();
        pauses.push(Math.round(row.seconds_until_available));
      }
      expect(pauses).toEqual([10, 20, 25]);
    });

    it("does not make a queued job claimable before its pause has passed", async () => {
      const kind = uniqueKind();
      await enqueue(orgA, kind);
      const claimed = await claimOne(kind);
      await fail(orgA, claimed, { code: "boom", retryable: true });
      const { jobs } = await claimJobs(h.dispatcher, { kinds: [kind], limit: 1, leaseSeconds: 60 });
      expect(jobs).toEqual([]);
    });

    it("ends the job when the failure is not retryable", async () => {
      const kind = uniqueKind();
      const jobId = await enqueue(orgA, kind);
      const claimed = await claimOne(kind);
      expect(await fail(orgA, claimed, { code: "bad_input", retryable: false })).toBe("dead");
      const row = await h.job(jobId);
      expect(row).toMatchObject({
        status: "dead",
        last_error_code: "bad_input",
        lease_token: null,
      });
      expect(row.finished_at).not.toBeNull();
    });

    it("ends the job when the attempts are used up, whatever the failure says", async () => {
      const kind = uniqueKind();
      const jobId = await enqueue(orgA, kind, { maxAttempts: 2 });
      const first = await claimOne(kind);
      expect(await fail(orgA, first, { code: "boom", retryable: true })).toBe("retry");
      await h.admin.query("UPDATE jobs SET available_at = now() WHERE id = $1", [jobId]);
      const second = await claimOne(kind);
      expect(await fail(orgA, second, { code: "boom", retryable: true })).toBe("dead");
      expect((await h.job(jobId)).status).toBe("dead");
    });

    it("changes nothing for a worker whose lease was taken over", async () => {
      const kind = uniqueKind();
      const jobId = await enqueue(orgA, kind);
      const zombie = await claimOne(kind);
      await h.expire(jobId);
      const holder = await claimOne(kind);
      expect(await fail(orgA, zombie, { code: "late", retryable: false })).toBe("lease_lost");
      const row = await h.job(jobId);
      expect(row).toMatchObject({ status: "running", lease_token: holder.leaseToken });
      expect(row.last_error_code).toBe("lease_expired");
    });

    it("changes nothing for another tenant", async () => {
      const kind = uniqueKind();
      const jobId = await enqueue(orgA, kind);
      const claimed = await claimOne(kind);
      expect(await fail(orgB, claimed, { code: "boom", retryable: false })).toBe("lease_lost");
      expect((await h.job(jobId)).status).toBe("running");
    });
  });

  describe("requeueJob", () => {
    const requeue = (org: string, kind: string, subjectId: string): Promise<boolean> =>
      withTenant(h.app, org, (client) => requeueJob(client, { kind, subjectId }));

    it("runs a finished job again with a fresh set of attempts", async () => {
      const kind = uniqueKind();
      const subjectId = randomUUID();
      const jobId = await enqueue(orgA, kind, { subjectId });
      const first = await claimOne(kind);
      await withTenant(h.app, orgA, (client) =>
        failJob(client, first, { code: "boom", retryable: false }),
      );
      expect((await h.job(jobId)).status).toBe("dead");

      expect(await requeue(orgA, kind, subjectId)).toBe(true);
      const row = await h.job(jobId);
      expect(row).toMatchObject({
        status: "queued",
        attempts: 0,
        lease_token: null,
        last_error_code: null,
      });
      expect(row.finished_at).toBeNull();

      const again = await claimOne(kind);
      expect(again).toMatchObject({ jobId, attempt: 1 });
      await withTenant(h.app, orgA, (client) => completeJob(client, again));
      expect(await requeue(orgA, kind, subjectId)).toBe(true);
    });

    it("leaves a waiting or running job alone", async () => {
      const kind = uniqueKind();
      const subjectId = randomUUID();
      const jobId = await enqueue(orgA, kind, { subjectId });
      expect(await requeue(orgA, kind, subjectId)).toBe(false);
      await claimOne(kind);
      expect(await requeue(orgA, kind, subjectId)).toBe(false);
      expect((await h.job(jobId)).status).toBe("running");
    });

    it("does nothing for a job that does not exist, or that belongs to another tenant", async () => {
      const kind = uniqueKind();
      const subjectId = randomUUID();
      const jobId = await enqueue(orgA, kind, { subjectId });
      const claimed = await claimOne(kind);
      await withTenant(h.app, orgA, (client) => completeJob(client, claimed));

      expect(await requeue(orgA, kind, randomUUID())).toBe(false);
      expect(await requeue(orgB, kind, subjectId)).toBe(false);
      expect((await h.job(jobId)).status).toBe("succeeded");
    });
  });
});
