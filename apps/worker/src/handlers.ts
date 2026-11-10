import { aggregateEventsHandler, EVENTS_AGGREGATE_KIND } from "@codemugs/ingestion";
import type { JobHandler } from "@codemugs/jobs";

/**
 * The kinds of job this process runs, and who runs each. A worker takes jobs of these kinds and
 * no others: a job of a kind that is not registered here stays queued until a worker that knows
 * it is started.
 */
export const handlers: Readonly<Record<string, JobHandler>> = {
  [EVENTS_AGGREGATE_KIND]: aggregateEventsHandler,
};
