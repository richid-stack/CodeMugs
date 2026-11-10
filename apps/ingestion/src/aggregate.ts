import { JobFailure, type JobHandler } from "@codemugs/jobs";
import type { TenantClient } from "@codemugs/storage";

/** The job kind that processes one accepted batch of events (ADR 0013). */
export const EVENTS_AGGREGATE_KIND = "events.aggregate";

/**
 * Which projects a batch's events belong to. A batch holds one project's events today, but the
 * code does not rely on that.
 */
const PROJECTS_OF_BATCH = `
  SELECT DISTINCT project_id FROM events WHERE organisation_id = $1 AND batch_id = $2
  ORDER BY project_id
`;

/**
 * Writes the count of events per hour, for every hour the batch has an event in, by counting the
 * events themselves (all batches, not only this one). The write replaces the stored count, so it
 * is the same however many times it runs and in whatever order batches are processed. Nothing
 * here adds to a number.
 *
 * The hour is the time the event says it happened (UTC), so a late event lands in its own hour.
 */
const RECOMPUTE = `
  WITH touched AS (
    SELECT DISTINCT project_id,
           date_bin('1 hour', occurred_at, timestamptz '2000-01-01 00:00:00+00') AS bucket_start
      FROM events
     WHERE organisation_id = $1 AND batch_id = $2
  ),
  counted AS (
    SELECT t.project_id, t.bucket_start, count(*) AS event_count
      FROM touched t
      JOIN events e ON e.organisation_id = $1 AND e.project_id = t.project_id
                   AND e.occurred_at >= t.bucket_start
                   AND e.occurred_at < t.bucket_start + interval '1 hour'
     GROUP BY t.project_id, t.bucket_start
  )
  INSERT INTO event_aggregates (organisation_id, project_id, bucket_start, event_count)
  SELECT $1, project_id, bucket_start, event_count FROM counted
   ORDER BY project_id, bucket_start
  ON CONFLICT (organisation_id, project_id, bucket_start)
  DO UPDATE SET event_count = EXCLUDED.event_count, updated_at = now()
`;

/**
 * The name of the lock that handlers hold while they count a project. Exported for tests only; it
 * is not part of the package's public surface.
 */
export const projectLockKey = (projectId: string): string =>
  `${EVENTS_AGGREGATE_KIND}:${projectId}`;

/**
 * Brings the hourly counts that a batch of events touches up to date. Returns how many hourly
 * counts were written.
 *
 * It must run in the transaction the job runs in, as the batch's organisation. Handlers for the
 * same project take turns: each one first takes a lock on the project that lasts until its
 * transaction ends, and only then counts. The count is a single statement that fixes the number to
 * write when it starts, so a handler that had to wait for a concurrent writer to finish would
 * still write the number it fixed before waiting, which can be older than what that writer saw.
 * Taking the lock first means every count starts after the previous handler for the project has
 * committed, so the last to write is the last to have counted.
 */
export async function aggregateEvents(client: TenantClient, batchId: string): Promise<number> {
  const projects = await client.query<{ project_id: string }>(PROJECTS_OF_BATCH, [
    client.organisationId,
    batchId,
  ]);
  // In one fixed order, so two batches that share projects can never wait on each other in a ring.
  for (const { project_id: projectId } of projects.rows) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
      projectLockKey(projectId),
    ]);
  }
  const written = await client.query(RECOMPUTE, [client.organisationId, batchId]);
  return written.rowCount ?? 0;
}

/** The handler to register with a worker: `{ [EVENTS_AGGREGATE_KIND]: aggregateEventsHandler }`. */
export const aggregateEventsHandler: JobHandler = async (job, { client }) => {
  if (job.subjectId === null) {
    // A job of this kind always has a batch. Retrying cannot fix one that does not.
    throw new JobFailure("missing_batch", { retryable: false });
  }
  await aggregateEvents(client, job.subjectId);
};
