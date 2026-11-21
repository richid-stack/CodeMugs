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
 *
 * With `readOnly` the transaction begins as a read-only one, and the database refuses (SQLSTATE
 * 25006) any statement in it that writes. Work that only reads should ask for it, so that a write
 * that it makes by mistake is an error and not something that is kept.
 */
export async function withTenant<T>(
  pool: Pool,
  organisationId: string,
  work: (client: TenantClient) => Promise<T>,
  options: { readonly readOnly?: boolean } = {},
): Promise<T> {
  const parsed = organisationIdSchema.safeParse(organisationId);
  if (!parsed.success) {
    // The rejected value is deliberately not echoed.
    throw new TenantContextError("organisationId must be a UUID");
  }

  const client = await pool.connect();
  let active = true;
  let discardConnection = false;
  // The pool listens for an error on a connection that is idle in the pool, and not on one that is
  // checked out. Without a listener here, the database ending the session (a transaction that sat
  // idle for too long, a restart) is an uncaught exception and ends the process, and what the work
  // was doing waiting for something other than the database is exactly when it happens. The first
  // error is kept: it is the cause, and what the next query says of it is only that it cannot run.
  let connectionError: Error | undefined;
  const onConnectionError = (error: Error): void => {
    connectionError ??= error;
  };
  client.on("error", onConnectionError);
  try {
    await client.query(options.readOnly === true ? "BEGIN READ ONLY" : "BEGIN");
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
    // A session that the database ended has rolled the transaction back, so there is nothing to
    // commit, and saying that the work succeeded would be untrue.
    if (connectionError !== undefined) throw connectionError;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // If even the rollback fails the connection is in an unknown state. Do not reuse it.
      discardConnection = true;
    }
    throw connectionError ?? error;
  } finally {
    active = false;
    client.removeListener("error", onConnectionError);
    client.release(discardConnection || connectionError !== undefined);
  }
}
