import type { Pool, QueryResult, QueryResultRow } from "pg";
import { z } from "zod";
import { TenantContextError } from "./errors.js";

const organisationIdSchema = z.uuid();

/**
 * What code running inside a tenant transaction can do: run queries, and nothing else.
 * It stops working the moment the transaction ends.
 */
export interface TenantClient {
  /** The organisation this transaction acts for. Read-only, and the same one row-level security uses. */
  readonly organisationId: string;
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * Runs `work` inside one transaction in which every query is restricted, by row-level security,
 * to the given organisation.
 *
 * The organisation must come from the authenticated credential (invariant 1), never from a
 * request body, query string or event payload. The setting is transaction-local, so it can
 * never leak to the next user of a pooled connection.
 */
export async function withTenant<T>(
  pool: Pool,
  organisationId: string,
  work: (client: TenantClient) => Promise<T>,
): Promise<T> {
  const parsed = organisationIdSchema.safeParse(organisationId);
  if (!parsed.success) {
    // The rejected value is deliberately not echoed.
    throw new TenantContextError("organisationId must be a UUID");
  }

  const client = await pool.connect();
  let active = true;
  let discardConnection = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [parsed.data]);
    const scoped: TenantClient = {
      organisationId: parsed.data,
      query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
        if (!active) {
          return Promise.reject(new TenantContextError("the tenant transaction has ended"));
        }
        return client.query<R>(text, values);
      },
    };
    const result = await work(scoped);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // If even the rollback fails the connection is in an unknown state. Do not reuse it.
      discardConnection = true;
    }
    throw error;
  } finally {
    active = false;
    client.release(discardConnection);
  }
}
