import { withTenant, type Pool, type TenantClient } from "@codemugs/storage";
import {
  classifyFailure,
  infrastructureCode,
  JobConfigurationError,
  LeaseLostError,
  NAME_PATTERN,
} from "./errors.js";
import {
  claimJobs,
  completeJob,
  DEFAULT_BACKOFF,
  failJob,
  type Backoff,
  type ClaimedJob,
} from "./queue.js";

export interface JobContext {
  /**
   * The transaction the job runs in, restricted to the job's organisation. When the handler
   * returns, the worker marks the job succeeded in this same transaction and commits it, so the
   * handler's writes and the job's completion happen together or not at all.
   */
  client: TenantClient;
  /**
   * Aborted when the lease runs out. The handler should stop promptly: after that another worker
   * may take the job, and if one does, this run's transaction is rolled back at the end.
   */
  signal: AbortSignal;
}

/**
 * Does the work for one job. It may run more than once for the same subject (a retry after a
 * failure, or after a crash), so it must give the same result when it does: derive the outcome
 * from the tenant's data and write it idempotently. A thrown error fails the attempt and rolls
 * back everything the handler wrote.
 */
export type JobHandler = (job: ClaimedJob, context: JobContext) => Promise<void>;

/**
 * The writes of a long job, made when its work is done. The worker runs them in the job's
 * transaction and completes the job in the same one, so they are exactly once, as a handler's are.
 */
export type JobCommit = (client: TenantClient) => Promise<void>;

export interface LongJobContext {
  /** Aborted when the lease runs out, as for a handler. */
  readonly signal: AbortSignal;
  /**
   * Runs `body` in a transaction restricted to the job's organisation, and ends it when `body`
   * does. It is for reading what the work needs (a row that says what to fetch). Keep it short:
   * a transaction that is idle for long is ended by the database (see `idleInTransactionTimeoutMs`
   * of the pool), and one that is open holds back the cleaning of old rows.
   */
  readonly read: <T>(body: (client: TenantClient) => Promise<T>) => Promise<T>;
}

/**
 * Does the work of a job that takes long, and gives back what to write. **No transaction is open
 * while it works**: a download, a sandbox or a model can take minutes, and the database ends a
 * transaction that sits idle for 30 seconds by default. The work reads through `context.read`, does
 * what it does, and returns the commit; it must not write to the database any other way.
 *
 * Like a handler it may run more than once for the same subject, and what it does outside the
 * database is at least once. Only the commit is exactly once. Choose a lease longer than the work.
 */
export type LongJobHandler = (job: ClaimedJob, context: LongJobContext) => Promise<JobCommit>;

/** A handler that works outside a transaction. Made with {@link longJob}. */
export interface LongJob {
  readonly long: LongJobHandler;
}

/** Registers a handler for a job that takes long, so that it works with no transaction open. */
export function longJob(handler: LongJobHandler): LongJob {
  return Object.freeze({ long: handler });
}

const isLongJob = (handler: unknown): handler is LongJob =>
  typeof handler === "object" &&
  handler !== null &&
  typeof (handler as { long?: unknown }).long === "function";

/**
 * What a worker reports about itself. Events carry identifiers, the kind, attempt numbers and
 * short codes, and never a message, payload or customer value (invariant 3).
 */
export type WorkerEvent =
  | ({ type: "claimed" } & JobRef)
  | ({ type: "succeeded" } & JobRef)
  | ({ type: "retrying"; code: string } & JobRef)
  | ({ type: "dead"; code: string } & JobRef)
  | ({ type: "lease_lost" } & JobRef)
  | { type: "error"; phase: "claim" | "complete" | "fail"; code: string; jobId?: string };

interface JobRef {
  jobId: string;
  organisationId: string;
  kind: string;
  attempt: number;
}

export interface WorkerOptions {
  /** A pool for the dispatcher role: finds due jobs in any tenant. Held by workers, never the API. */
  dispatcher: Pool;
  /** A pool for the application role. Needs at least `concurrency` connections. */
  app: Pool;
  /** One handler per job kind. The worker takes jobs of these kinds and no others. */
  handlers: Readonly<Record<string, JobHandler | LongJob>>;
  /** Stops the worker: no new jobs are taken, and jobs in progress are finished first. */
  signal: AbortSignal;
  /** Jobs run at the same time. Default 4. */
  concurrency?: number;
  /** How long to wait before looking for work again when there was none. Default 1000. */
  pollIntervalMs?: number;
  /** How long a worker holds a job before another may take it. Default 60. */
  leaseSeconds?: number;
  backoff?: Backoff;
  onEvent?: (event: WorkerEvent) => void;
}

/** Waits `ms`, or less if the signal aborts. Never leaves a timer running. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Takes jobs and runs them until `signal` aborts, then waits for the jobs in progress and
 * returns. It does not throw because of a job, or because the database is unreachable: it reports
 * through `onEvent` and tries again.
 *
 * Delivery is at least once. A job whose worker dies is taken again when its lease runs out. The
 * effect of a handler is exactly once for whatever it writes in the transaction it is given.
 */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const { dispatcher, app, signal } = options;
  const concurrency = options.concurrency ?? 4;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const leaseSeconds = options.leaseSeconds ?? 60;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;

  const handlers = new Map(Object.entries(options.handlers));
  if (handlers.size === 0) throw new JobConfigurationError("a worker needs at least one handler");
  for (const [kind, handler] of handlers) {
    if (!NAME_PATTERN.test(kind)) throw new JobConfigurationError("a handler kind is not valid");
    if (typeof handler !== "function" && !isLongJob(handler)) {
      throw new JobConfigurationError("a handler is not a function or a long job");
    }
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new JobConfigurationError("concurrency must be a whole number from 1 to 100");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10) {
    throw new JobConfigurationError("pollIntervalMs must be a whole number of at least 10");
  }
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 86_400) {
    throw new JobConfigurationError("leaseSeconds must be a whole number from 1 to 86400");
  }
  // Every job in progress holds a connection. With fewer connections than jobs, jobs would wait
  // for one until the pool gave up, and fail for a reason that has nothing to do with the work.
  if (concurrency > (app.options.max ?? 10)) {
    throw new JobConfigurationError("the application pool has fewer connections than concurrency");
  }

  const emit = (event: WorkerEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // A faulty observer must not stop the worker.
    }
  };
  const ref = (job: ClaimedJob): JobRef => ({
    jobId: job.jobId,
    organisationId: job.organisationId,
    kind: job.kind,
    attempt: job.attempt,
  });

  async function execute(job: ClaimedJob): Promise<void> {
    emit({ type: "claimed", ...ref(job) });
    const handler = handlers.get(job.kind);
    try {
      if (handler === undefined) throw new Error("no handler");
      const leaseExpired = AbortSignal.timeout(leaseSeconds * 1_000);
      if (isLongJob(handler)) {
        const commit = await handler.long(job, {
          signal: leaseExpired,
          read: (body) => withTenant(app, job.organisationId, body),
        });
        await withTenant(app, job.organisationId, async (client) => {
          await commit(client);
          await completeJob(client, job);
        });
      } else {
        await withTenant(app, job.organisationId, async (client) => {
          await handler(job, { client, signal: leaseExpired });
          await completeJob(client, job);
        });
      }
      emit({ type: "succeeded", ...ref(job) });
      return;
    } catch (error) {
      if (error instanceof LeaseLostError) {
        emit({ type: "lease_lost", ...ref(job) });
        return;
      }
      const failure = classifyFailure(error);
      try {
        const outcome = await withTenant(app, job.organisationId, (client) =>
          failJob(client, job, failure, backoff),
        );
        if (outcome === "lease_lost") emit({ type: "lease_lost", ...ref(job) });
        else if (outcome === "retry") {
          emit({ type: "retrying", code: failure.code, ...ref(job) });
        } else emit({ type: "dead", code: failure.code, ...ref(job) });
      } catch (recordingError) {
        // The attempt could not even be recorded. The job stays leased and is taken again when
        // the lease runs out, which counts the attempt that has just been lost.
        emit({
          type: "error",
          phase: "fail",
          code: infrastructureCode(recordingError),
          jobId: job.jobId,
        });
      }
    }
  }

  const stopped = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  const running = new Set<Promise<void>>();

  while (!signal.aborted) {
    const free = concurrency - running.size;
    if (free > 0) {
      try {
        const { jobs, abandoned } = await claimJobs(dispatcher, {
          kinds: [...handlers.keys()],
          limit: free,
          leaseSeconds,
        });
        for (const job of abandoned) {
          emit({
            type: "dead",
            code: "lease_expired",
            jobId: job.jobId,
            organisationId: job.organisationId,
            kind: job.kind,
            attempt: job.attempts,
          });
        }
        // Jobs taken just as the worker is told to stop are still run: their leases are held,
        // and abandoning them would only make them wait for the lease to run out.
        for (const job of jobs) {
          const task: Promise<void> = execute(job)
            .catch((error: unknown) => {
              // Unreachable by design (execute reports its own failures), but an unexpected
              // throw must never become an unhandled rejection that ends the process.
              emit({
                type: "error",
                phase: "complete",
                code: infrastructureCode(error),
                jobId: job.jobId,
              });
            })
            .then(() => {
              running.delete(task);
            });
          running.add(task);
        }
      } catch (error) {
        emit({ type: "error", phase: "claim", code: infrastructureCode(error) });
      }
    }

    // Wait for a job to finish (a slot frees up), for the poll interval if there is room for
    // more, or for the stop signal.
    const wake: Array<Promise<void>> = [...running, stopped];
    const woken = new AbortController();
    if (running.size < concurrency) {
      wake.push(pause(pollIntervalMs, AbortSignal.any([signal, woken.signal])));
    }
    await Promise.race(wake);
    woken.abort(); // Cancels the pause's timer if something else woke the worker first.
  }

  await Promise.all(running);
}
