import { withTenant, type Pool } from "@codemugs/storage";
import type { EventEnvelope } from "@codemugs/event-schemas";
import {
  checkBatchShape,
  validateEvent,
  type BatchShapeError,
  type Rejection,
} from "./validate.js";

/** Who is sending. All three come from the authenticated API key, never from the request. */
export interface IngestScope {
  organisationId: string;
  projectId: string;
  apiKeyId: string;
}

/** What happened to one event of the batch, in the order the client sent them. */
export type EventResult =
  | { index: number; eventId: string; status: "accepted" | "duplicate" }
  | ({ index: number; eventId?: string; status: "rejected" } & Rejection);

export interface IngestResult {
  results: EventResult[];
  accepted: number;
  duplicates: number;
  rejected: number;
}

export type IngestOutcome =
  { ok: true; result: IngestResult } | { ok: false; error: BatchShapeError };

export interface IngestOptions {
  /** For tests of the timestamp window. */
  now?: () => Date;
}

/**
 * One statement, one transaction, one parameter. The batch travels as a single JSON document, so
 * there is nothing to escape and no limit on the number of parameters. A duplicate is not an
 * error: ON CONFLICT DO NOTHING skips it, and the rows RETURNING are exactly the ones inserted.
 *
 * Rows go in ordered by event id. Two clients retrying overlapping batches would otherwise insert
 * the same keys in opposite orders, wait for each other, and deadlock (SQLSTATE 40P01), which the
 * API would answer with a 500 and the client would retry again.
 */
const INSERT_EVENTS = `
  INSERT INTO events (organisation_id, project_id, event_id, api_key_id, schema_version, type,
                      occurred_at, environment, sdk_name, sdk_version, attributes)
  SELECT $1::uuid, $2::uuid, e.event_id, $3::uuid, e.schema_version, e.type,
         e.occurred_at, e.environment, e.sdk_name, e.sdk_version, e.attributes
  FROM jsonb_to_recordset($4::jsonb) AS e(
    event_id uuid, schema_version smallint, type text, occurred_at timestamptz,
    environment text, sdk_name text, sdk_version text, attributes jsonb)
  ORDER BY e.event_id
  ON CONFLICT (organisation_id, project_id, event_id) DO NOTHING
  RETURNING event_id
`;

/**
 * Validates a request body and durably records the events in it.
 *
 * Every event gets its own result. An event that cannot be accepted is rejected with a reason,
 * and the rest of the batch is stored anyway, so one bad event never blocks a batch that a client
 * will keep retrying. An event that was already stored (the client retried, or the same id appears
 * twice in the batch) is reported as a duplicate and is not stored again. The first copy wins:
 * a retry with different content is not detected.
 *
 * The caller's tenant is the scope, which comes from the credential. A failure of the database
 * is thrown, never turned into a result, so a client retries instead of dropping events.
 */
export async function recordEvents(
  pool: Pool,
  scope: IngestScope,
  body: unknown,
  options: IngestOptions = {},
): Promise<IngestOutcome> {
  const shape = checkBatchShape(body);
  if ("error" in shape) return { ok: false, error: shape.error };

  const now = (options.now ?? (() => new Date()))();
  const results: EventResult[] = [];
  const toStore: Array<{ index: number; key: string; event: EventEnvelope }> = [];
  const seen = new Set<string>();

  shape.items.forEach((item, index) => {
    const checked = validateEvent(item, now);
    if ("rejection" in checked) {
      const eventId = echoableEventId(item);
      results[index] = {
        index,
        ...(eventId === undefined ? {} : { eventId }),
        status: "rejected",
        ...checked.rejection,
      };
      return;
    }
    // PostgreSQL stores a uuid in lower case, so "ABC..." and "abc..." are the same event.
    const key = checked.event.eventId.toLowerCase();
    if (seen.has(key)) {
      results[index] = { index, eventId: checked.event.eventId, status: "duplicate" };
      return;
    }
    seen.add(key);
    toStore.push({ index, key, event: checked.event });
  });

  if (toStore.length > 0) {
    const inserted = await withTenant(pool, scope.organisationId, async (client) => {
      const document = toStore.map(({ event }) => ({
        event_id: event.eventId,
        schema_version: event.schemaVersion,
        type: event.type,
        // Normalised, so every offset and precision the schema allows becomes one form.
        occurred_at: new Date(event.occurredAt).toISOString(),
        environment: event.environment,
        sdk_name: event.sdk.name,
        sdk_version: event.sdk.version,
        attributes: event.attributes,
      }));
      const result = await client.query<{ event_id: string }>(INSERT_EVENTS, [
        client.organisationId,
        scope.projectId,
        scope.apiKeyId,
        JSON.stringify(document),
      ]);
      return new Set(result.rows.map((row) => row.event_id.toLowerCase()));
    });

    for (const { index, key, event } of toStore) {
      results[index] = {
        index,
        eventId: event.eventId,
        status: inserted.has(key) ? "accepted" : "duplicate",
      };
    }
  }

  const count = (status: EventResult["status"]): number =>
    results.filter((result) => result.status === status).length;
  return {
    ok: true,
    result: {
      results,
      accepted: count("accepted"),
      duplicates: count("duplicate"),
      rejected: count("rejected"),
    },
  };
}

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A rejected event's id, if it has one that is safe to repeat: a UUID is a fixed, harmless shape. */
function echoableEventId(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
  const candidate = (item as Record<string, unknown>)["eventId"];
  return typeof candidate === "string" && UUID_SHAPE.test(candidate) ? candidate : undefined;
}
