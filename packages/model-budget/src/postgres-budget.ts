import { randomUUID } from "node:crypto";
import type {
  BudgetClaim,
  BudgetGrant,
  BudgetLedger,
  BudgetReservation,
  BudgetUsageRecord,
} from "@codemugs/model-gateway";
import { withTenant, type Pool } from "@codemugs/storage";

/**
 * The budget ledger of the model gateway, kept in PostgreSQL (ADR 0042). It survives a restart and is
 * the same for every process that uses the database, so a limit is one limit and not one for each
 * process. Every statement runs as the organisation that is being charged, under row-level security.
 */

export interface PostgresBudgetOptions {
  /** A pool for the application role (`codemugs_app`). */
  readonly pool: Pool;
}

export interface PostgresBudget extends BudgetLedger {
  /** What is counted as spent: this month for an organisation (UTC), or over all months for a task. */
  usedMicros(organisationId: string, taskId?: string): Promise<number>;
}

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * One at a time for an organisation: a claim is checked against what has been spent and then added to
 * it, and two claims that did this together could both fit when they do not. The lock is held to the end
 * of the transaction and needs no privilege on any table.
 */
const LOCK = "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))";
// PostgreSQL reads a UUID in capitals and in lower case as the same organisation, so the key is made
// from the lower-case spelling: two spellings must not be two locks.
const lockKey = (organisationId: string): string =>
  `codemugs:model_budget:${organisationId.toLowerCase()}`;

/**
 * Adds the entry that closes a reservation: for the difference between what it was charged and what it
 * reserved. It takes the reserved amount and the month from the reservation's own entry, so that what
 * the caller remembers of them does not matter, and it does nothing if the reservation has been closed
 * already or is not this organisation's. It is one statement and takes no lock: a claim that does not see
 * it yet is no worse off than one that ran just before it, and a charge above the reservation is allowed
 * to pass a limit in any case (ADR 0041, decision 6).
 */
const CLOSE = `
  INSERT INTO model_ledger_entries
    (organisation_id, id, reservation_id, kind, period, task_id, micros,
     provider, model, outcome, input_tokens, output_tokens)
  SELECT r.organisation_id, $3::uuid, r.reservation_id, $4::text, r.period, r.task_id,
         $5::bigint - r.micros, $6::text, $7::text, $8::text, $9::bigint, $10::bigint
    FROM model_ledger_entries r
   WHERE r.organisation_id = $1 AND r.reservation_id = $2 AND r.kind = 'reserve'
  ON CONFLICT (organisation_id, reservation_id) WHERE kind <> 'reserve' DO NOTHING`;

/**
 * What a sum of entries says has been spent. A negative sum cannot be right (every settle is against a
 * reservation, which is not negative), and treating it as credit would grant what the limit does not
 * allow, so it throws, and the gateway sends nothing.
 */
function spentOf(sum: string | undefined): bigint {
  const spent = BigInt(sum ?? "0");
  if (spent < 0n) throw new RangeError("the ledger holds a negative total");
  return spent;
}

function isAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** A sum from the database, which comes as text, as a number that is exact. */
function exact(value: string): number {
  const amount = BigInt(value);
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("an amount from the ledger is out of range");
  }
  return Number(amount);
}

export function createPostgresBudget(options: PostgresBudgetOptions): PostgresBudget {
  const { pool } = options;

  function reservationOf(organisationId: string, reservationId: string): BudgetReservation {
    const close = (
      kind: "settle" | "release",
      chargedMicros: number,
      record?: BudgetUsageRecord,
    ): Promise<void> =>
      withTenant(pool, organisationId, async (db) => {
        await db.query(CLOSE, [
          organisationId,
          reservationId,
          randomUUID(),
          kind,
          chargedMicros,
          record?.provider ?? null,
          record?.model ?? null,
          record?.outcome ?? null,
          record?.inputTokens ?? null,
          record?.outputTokens ?? null,
        ]);
      });
    return {
      settle: (chargedMicros, record) =>
        isAmount(chargedMicros)
          ? close("settle", chargedMicros, record)
          : Promise.reject(new RangeError("a charge is a whole amount")),
      release: () => close("release", 0),
    };
  }

  async function reserve(claim: BudgetClaim): Promise<BudgetGrant> {
    if (!isAmount(claim.micros)) throw new RangeError("a claim is a whole amount");
    if (claim.taskId !== undefined && !TASK_ID.test(claim.taskId)) {
      throw new RangeError("a task id is not valid");
    }
    const { organisationId, taskId } = claim;
    const reservationId = randomUUID();

    const refused = await withTenant(pool, organisationId, async (db) => {
      await db.query(LOCK, [lockKey(organisationId)]);
      // The month is the database's, so that every process agrees on which one it is. It is read from
      // the clock now, after the lock: now() is the start of the transaction, which may be before a
      // month ended that this claim waited through.
      const limits = await db.query<{ monthly: string; task: string | null; period: string }>(
        `SELECT monthly_micros::text AS monthly, task_micros::text AS task,
                date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date::text AS period
           FROM model_budgets WHERE organisation_id = $1`,
        [organisationId],
      );
      const row = limits.rows[0];
      // No budget for the organisation: money is not spent for someone whose limit nobody set.
      if (row === undefined) return "organisation" as const;

      const wanted = BigInt(claim.micros);
      const monthSpent = await db.query<{ used: string }>(
        `SELECT coalesce(sum(micros), 0)::text AS used
           FROM model_ledger_entries WHERE organisation_id = $1 AND period = $2::date`,
        [organisationId, row.period],
      );
      if (spentOf(monthSpent.rows[0]?.used) + wanted > BigInt(row.monthly)) {
        return "organisation" as const;
      }
      if (taskId !== undefined && row.task !== null) {
        const taskSpent = await db.query<{ used: string }>(
          `SELECT coalesce(sum(micros), 0)::text AS used
             FROM model_ledger_entries WHERE organisation_id = $1 AND task_id = $2`,
          [organisationId, taskId],
        );
        if (spentOf(taskSpent.rows[0]?.used) + wanted > BigInt(row.task)) {
          return "task" as const;
        }
      }

      await db.query(
        `INSERT INTO model_ledger_entries
           (organisation_id, id, reservation_id, kind, period, task_id, micros)
         VALUES ($1, $2, $3, 'reserve', $4::date, $5, $6)`,
        [organisationId, randomUUID(), reservationId, row.period, taskId ?? null, claim.micros],
      );
      return undefined;
    });

    if (refused !== undefined) return { ok: false, limit: refused };
    return { ok: true, reservation: reservationOf(organisationId, reservationId) };
  }

  return {
    reserve,
    // A read, which waits for no lock, so now() (one value for the whole statement) is the right clock:
    // clock_timestamp() changes while a scan runs, and a scan across a month's end could count rows
    // against two months.
    usedMicros: (organisationId, taskId) =>
      withTenant(
        pool,
        organisationId,
        async (db) => {
          const result =
            taskId === undefined
              ? await db.query<{ used: string }>(
                  `SELECT coalesce(sum(micros), 0)::text AS used
                     FROM model_ledger_entries
                    WHERE organisation_id = $1
                      AND period = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
                  [organisationId],
                )
              : await db.query<{ used: string }>(
                  `SELECT coalesce(sum(micros), 0)::text AS used
                     FROM model_ledger_entries WHERE organisation_id = $1 AND task_id = $2`,
                  [organisationId, taskId],
                );
          return exact(result.rows[0]?.used ?? "0");
        },
        { readOnly: true },
      ),
  };
}
