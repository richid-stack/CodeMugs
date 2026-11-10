import type { Pool, TenantClient } from "@codemugs/storage";
import { JobConfigurationError, LeaseLostError, NAME_PATTERN, type Failure } from "./errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long the pause before a retry grows: base * 2^(attempt - 1) seconds, up to a cap. */
export interface Backoff {
  baseSeconds: number;
  maxSeconds: number;
}

export const DEFAULT_BACKOFF: Backoff = { baseSeconds: 5, maxSeconds: 900 };

function requireKind(kind: string): void {
  if (!NAME_PATTERN.test(kind)) {
    throw new JobConfigurationError(
      "a job kind must be 1 to 64 characters: a lower-case letter, then lower-case letters, digits, '_', '.' or '-'",
    );
  }
}

function requireInteger(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new JobConfigurationError(`${name} must be a whole number from ${min} to ${max}`);
  }
}

/** A job a worker has taken. `leaseToken` proves it still holds the job when it finishes. */
export interface ClaimedJob {
  jobId: string;
  organisationId: string;
  kind: string;
  /** What the job is about (a tenant row, or a batch of rows), or null. Never any other data: look it up in the tenant. */
  subjectId: string | null;
  /** 1 for the first try. */
  attempt: number;
  maxAttempts: number;
  leaseToken: string;
}

/** A job whose last lease ran out with no tries left: it is now dead. */
export interface AbandonedJob {
  jobId: string;
  organisationId: string;
  kind: string;
  attempts: number;
}

export type EnqueueResult = { status: "enqueued"; jobId: string } | { status: "exists" };

/**
 * Adds a job for the organisation the transaction acts for. Call it inside the same transaction
 * that wrote the work the job is about, so the job exists if and only if the work does.
 *
 * A job is identified by (kind, subjectId). Enqueueing the same pair again changes nothing and
 * returns `exists`, whatever state the first job is in. To run a finished job again, use
 * `requeueJob`. A job with no subject is never a duplicate of another.
 */
export async function enqueueJob(
  client: TenantClient,
  job: { kind: string; subjectId?: string; maxAttempts?: number },
): Promise<EnqueueResult> {
  requireKind(job.kind);
  if (job.subjectId !== undefined && !UUID_PATTERN.test(job.subjectId)) {
    throw new JobConfigurationError("a job subjectId must be a UUID");
  }
  if (job.maxAttempts !== undefined) requireInteger("maxAttempts", job.maxAttempts, 1, 100);

  const result = await client.query<{ id: string }>(
    `INSERT INTO jobs (organisation_id, kind, subject_id, max_attempts)
     VALUES ($1, $2, $3, COALESCE($4::integer, 5))
     ON CONFLICT (organisation_id, kind, subject_id) DO NOTHING
     RETURNING id`,
    [client.organisationId, job.kind, job.subjectId ?? null, job.maxAttempts ?? null],
  );
  const row = result.rows[0];
  return row === undefined ? { status: "exists" } : { status: "enqueued", jobId: row.id };
}

/**
 * Puts a finished job (succeeded or dead) back in the queue with a fresh set of attempts. This
 * is replay. It returns false, and changes nothing, if there is no such job or it has not
 * finished: a waiting or running job will run anyway, and starting a second run next to a
 * running one would break the guarantee that one worker holds a job at a time.
 *
 * The handler must be safe to run again for the same subject (ADR 0012).
 */
export async function requeueJob(
  client: TenantClient,
  job: { kind: string; subjectId: string },
): Promise<boolean> {
  requireKind(job.kind);
  if (!UUID_PATTERN.test(job.subjectId)) {
    throw new JobConfigurationError("a job subjectId must be a UUID");
  }
  const result = await client.query(
    `UPDATE jobs
        SET status = 'queued', attempts = 0, available_at = now(), lease_token = NULL,
            last_error_code = NULL, finished_at = NULL
      WHERE kind = $1 AND subject_id = $2 AND status IN ('succeeded', 'dead')`,
    [job.kind, job.subjectId],
  );
  return result.rowCount === 1;
}

export interface ClaimOptions {
  /** Only jobs of these kinds are taken. */
  kinds: readonly string[];
  /** The most jobs to take at once. */
  limit: number;
  /** How long the worker holds each job before another may take it. */
  leaseSeconds: number;
}

/**
 * Takes up to `limit` jobs that are due, in any tenant, and gives each a lease. Run it with the
 * dispatcher pool: it is the one role that can see jobs across tenants.
 *
 * A job is due when it is queued and its time has come, or when it is running and its lease has
 * run out (its worker is presumed dead). Taking one counts as an attempt. A job whose lease ran
 * out with no attempts left is not taken: it is marked dead and reported in `abandoned`.
 *
 * Workers that call this at the same time never take the same job: rows another worker has
 * locked are skipped, not waited for.
 */
export async function claimJobs(
  dispatcher: Pool,
  options: ClaimOptions,
): Promise<{ jobs: ClaimedJob[]; abandoned: AbandonedJob[] }> {
  if (options.kinds.length === 0) throw new JobConfigurationError("kinds must not be empty");
  for (const kind of options.kinds) requireKind(kind);
  requireInteger("limit", options.limit, 1, 100);
  requireInteger("leaseSeconds", options.leaseSeconds, 1, 86_400);

  // Jobs that crashed their last allowed attempt are finished off first, so they are reported
  // rather than left running for ever. Any worker may do this: it needs no handler.
  const abandoned = await dispatcher.query<{
    job_id: string;
    organisation_id: string;
    kind: string;
    attempts: number;
  }>(
    `WITH exhausted AS (
       SELECT id FROM jobs
        WHERE status = 'running' AND available_at <= now() AND attempts >= max_attempts
        ORDER BY available_at, id
        LIMIT 100
        FOR UPDATE SKIP LOCKED
     )
     UPDATE jobs j
        SET status = 'dead', lease_token = NULL, finished_at = now(),
            last_error_code = 'lease_expired'
       FROM exhausted e
      WHERE j.id = e.id
     RETURNING j.id AS job_id, j.organisation_id, j.kind, j.attempts`,
  );

  const taken = await dispatcher.query<{
    job_id: string;
    organisation_id: string;
    kind: string;
    subject_id: string | null;
    attempt: number;
    max_attempts: number;
    lease_token: string;
  }>(
    `WITH due AS (
       SELECT id FROM jobs
        WHERE status IN ('queued', 'running') AND available_at <= now()
          AND attempts < max_attempts AND kind = ANY ($1::text[])
        ORDER BY available_at, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE jobs j
        SET status = 'running',
            attempts = j.attempts + 1,
            lease_token = gen_random_uuid(),
            available_at = now() + make_interval(secs => $3::float8),
            last_error_code = CASE WHEN j.status = 'running' THEN 'lease_expired'
                                   ELSE j.last_error_code END
       FROM due
      WHERE j.id = due.id
     RETURNING j.id AS job_id, j.organisation_id, j.kind, j.subject_id,
               j.attempts AS attempt, j.max_attempts, j.lease_token`,
    [[...options.kinds], options.limit, options.leaseSeconds],
  );

  return {
    abandoned: abandoned.rows.map((row) => ({
      jobId: row.job_id,
      organisationId: row.organisation_id,
      kind: row.kind,
      attempts: row.attempts,
    })),
    jobs: taken.rows.map((row) => ({
      jobId: row.job_id,
      organisationId: row.organisation_id,
      kind: row.kind,
      subjectId: row.subject_id,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      leaseToken: row.lease_token,
    })),
  };
}

/**
 * Marks a job succeeded. Call it inside the tenant transaction that did the work, so the work
 * and its completion commit together or not at all: that is what makes a job's effect happen
 * exactly once even though delivery is at least once.
 *
 * Throws LeaseLostError if the worker no longer holds the lease. The transaction must then be
 * rolled back, which throwing out of `withTenant` does.
 */
export async function completeJob(
  client: TenantClient,
  job: Pick<ClaimedJob, "jobId" | "leaseToken">,
): Promise<void> {
  const result = await client.query(
    `UPDATE jobs
        SET status = 'succeeded', lease_token = NULL, finished_at = now()
      WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [job.jobId, job.leaseToken],
  );
  if (result.rowCount !== 1) throw new LeaseLostError();
}

export type FailOutcome = "retry" | "dead" | "lease_lost";

/**
 * Records a failed attempt, in its own tenant transaction after the work's was rolled back. The
 * job goes back to the queue after a pause that grows with each attempt, or becomes dead when
 * the failure is not retryable or the attempts are used up.
 *
 * Returns `lease_lost`, and changes nothing, if the worker no longer holds the lease.
 */
export async function failJob(
  client: TenantClient,
  job: Pick<ClaimedJob, "jobId" | "leaseToken">,
  failure: Failure,
  backoff: Backoff = DEFAULT_BACKOFF,
): Promise<FailOutcome> {
  const result = await client.query<{ status: string }>(
    `UPDATE jobs
        SET status = CASE WHEN $3::boolean AND attempts < max_attempts THEN 'queued' ELSE 'dead' END,
            available_at = CASE WHEN $3::boolean AND attempts < max_attempts
                                THEN now() + make_interval(
                                       secs => least($5::float8, $4::float8 * power(2, attempts - 1)))
                                ELSE available_at END,
            lease_token = NULL,
            last_error_code = $6,
            finished_at = CASE WHEN $3::boolean AND attempts < max_attempts THEN NULL
                               ELSE now() END
      WHERE id = $1 AND lease_token = $2 AND status = 'running'
     RETURNING status`,
    [
      job.jobId,
      job.leaseToken,
      failure.retryable,
      backoff.baseSeconds,
      backoff.maxSeconds,
      failure.code,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return "lease_lost";
  return row.status === "queued" ? "retry" : "dead";
}
