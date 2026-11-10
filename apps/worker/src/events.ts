import type { WorkerEvent } from "@codemugs/jobs";
import type { Logger } from "./logger.js";

/**
 * Writes what a worker reports about itself. Each field is copied by name, so nothing a future
 * version of the library adds to an event reaches the log without being chosen here. Events carry
 * identifiers, the kind, the attempt number and a short code, and never a message or a value from
 * a job's data (ADR 0012).
 */
export function logWorkerEvent(logger: Logger, event: WorkerEvent): void {
  if (event.type === "error") {
    logger.error("worker error", {
      phase: event.phase,
      code: event.code,
      jobId: event.jobId,
    });
    return;
  }
  const job = {
    jobId: event.jobId,
    organisationId: event.organisationId,
    kind: event.kind,
    attempt: event.attempt,
  };
  switch (event.type) {
    case "claimed":
      logger.debug("job claimed", job);
      return;
    case "succeeded":
      logger.info("job succeeded", job);
      return;
    case "retrying":
      logger.warn("job failed and will be tried again", { ...job, code: event.code });
      return;
    case "dead":
      logger.error("job failed for good", { ...job, code: event.code });
      return;
    case "lease_lost":
      logger.warn("job lease was lost to another worker", job);
      return;
  }
}
