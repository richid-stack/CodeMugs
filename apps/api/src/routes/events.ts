import { MAX_EVENTS_PER_BATCH, type BatchShapeError } from "@codemugs/ingestion";
import type { FastifyInstance } from "fastify";
import type { EventIngester } from "../ingestion.js";

const BATCH_MESSAGES: Record<BatchShapeError, string> = {
  body_not_an_object: 'The request body must be a JSON object: { "events": [ ... ] }',
  events_missing: 'The request body must contain an "events" array',
  events_empty: "A batch must contain at least one event",
  too_many_events: `A batch can contain at most ${MAX_EVENTS_PER_BATCH} events`,
};

/**
 * `POST /v1/events`. Registered inside the authenticated scope, so `request.principal` is always
 * set here. The organisation, project and key that the events are recorded under come from it
 * and from nothing in the request.
 *
 * The status describes the request and the body describes each event: `202` means the batch was
 * understood and every event was either stored, recognised as already stored, or rejected with a
 * reason. A client should drop rejected events (retrying cannot help) and retry only on `5xx`.
 */
export function registerEventRoutes(
  v1: FastifyInstance,
  { ingester }: { ingester: EventIngester | undefined },
): void {
  v1.post("/events", async (request, reply) => {
    const principal = request.principal;
    if (principal === null) {
      // Unreachable: the authentication hook answers every request that has no principal.
      throw new Error("authenticated route reached without a principal");
    }
    if (ingester === undefined) {
      return reply.code(503).send({
        error: {
          code: "ingestion_unavailable",
          message: "Event ingestion is not available",
          requestId: request.id,
        },
      });
    }

    const outcome = await ingester(principal, request.body);
    if (!outcome.ok) {
      return reply.code(400).send({
        error: {
          code: outcome.error,
          message: BATCH_MESSAGES[outcome.error],
          requestId: request.id,
        },
      });
    }

    const { accepted, duplicates, rejected, results } = outcome.result;
    return reply.code(202).send({ accepted, duplicates, rejected, results });
  });
}
