/**
 * What a call may spend, and what it did spend. The gateway asks the ledger for room **before** each
 * attempt at a provider, for the worst that the attempt can cost, and tells it what the attempt did
 * cost afterwards, so that work stops when the money does (release gate 17). The ledger is an
 * interface: this package has one that lives in memory, for tests and development, and a deployment
 * gives one that survives a restart.
 *
 * Amounts are whole millionths of a US dollar, as everywhere in this package.
 */

/** A claim on the budget of one attempt. The organisation is the call's, from the caller's authority. */
export interface BudgetClaim {
  readonly organisationId: string;
  /** The task that the call is part of, if the caller has one: it has a budget of its own. */
  readonly taskId?: string;
  /** The most that the attempt can cost. */
  readonly micros: number;
}

/**
 * What an attempt was, for a ledger that keeps usage: names, a code and counts, and **nothing that was
 * said** (no prompt, no answer, no message of a provider).
 */
export interface BudgetUsageRecord {
  readonly provider: string;
  readonly model: string;
  /** "ok", or the code that the attempt failed with. */
  readonly outcome: string;
  /** What the provider said it used. Absent when it did not say. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** Room that has been taken for one attempt. It is settled or released once; a second call does nothing. */
export interface BudgetReservation {
  /** Replaces the reservation with what the attempt was charged. It may be more than was reserved. */
  settle(chargedMicros: number, record?: BudgetUsageRecord): Promise<void>;
  /** Gives all of it back: nothing was spent. */
  release(): Promise<void>;
}

export type BudgetGrant =
  | { readonly ok: true; readonly reservation: BudgetReservation }
  | {
      readonly ok: false;
      /** Which limit is in the way: the organisation's for the period, or the task's. */
      readonly limit: "organisation" | "task";
    };

/**
 * The room that organisations and tasks have. `reserve` must be atomic: two claims that together do
 * not fit must not both be granted. It rejects when the ledger cannot be read, and the gateway then
 * sends nothing (it fails closed). **A reservation that is never settled stays counted as spent**, at
 * its worst case, so that a process that dies between the two cannot make money reappear.
 */
export interface BudgetLedger {
  reserve(claim: BudgetClaim): Promise<BudgetGrant>;
}

/**
 * A ledger with no limit, for tests and for development. **Nothing is stopped by it.** A deployment
 * that calls real providers gives a ledger that has limits, which is why the gateway has no default.
 */
export function unlimitedBudget(): BudgetLedger {
  return {
    reserve: () =>
      Promise.resolve({
        ok: true,
        reservation: { settle: () => Promise.resolve(), release: () => Promise.resolve() },
      }),
  };
}

/** What one organisation, and one of its tasks, may spend. */
export interface BudgetLimits {
  /** For each calendar month, UTC. 0 is allowed and stops everything. */
  readonly organisationMonthlyMicros: number;
  /** For each task id, for as long as the ledger holds it. No limit on tasks if absent. */
  readonly taskMicros?: number;
}

export interface MemoryBudgetOptions {
  /**
   * The limits of an organisation. An organisation that has none is refused: money is not spent for
   * someone whose limit nobody set.
   */
  readonly limits: (organisationId: string) => BudgetLimits | undefined;
  readonly now?: () => number;
}

export interface MemoryBudget extends BudgetLedger {
  /** What is counted as spent: settled amounts and reservations still out. This month for an organisation, or for a task. */
  usedMicros(organisationId: string, taskId?: string): number;
}

function isAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * A ledger in memory, per process: it forgets everything when the process ends, it is not shared
 * between processes, and it keeps a record for every task it has seen. For tests and development, and
 * for nothing else. The one that survives a restart is the next part.
 */
export function createMemoryBudget(options: MemoryBudgetOptions): MemoryBudget {
  const now = options.now ?? Date.now;
  const used = new Map<string, number>();
  const periodKey = (organisationId: string): string =>
    `organisation:${organisationId}:${new Date(now()).toISOString().slice(0, 7)}`;
  const taskKey = (organisationId: string, taskId: string): string =>
    `task:${organisationId}:${taskId}`;
  const add = (key: string, micros: number): void => {
    used.set(key, (used.get(key) ?? 0) + micros);
  };

  return {
    reserve(claim) {
      try {
        if (!isAmount(claim.micros)) throw new RangeError("a claim is a whole amount");
        const limits = options.limits(claim.organisationId);
        if (limits === undefined) return Promise.resolve({ ok: false, limit: "organisation" });
        if (
          !isAmount(limits.organisationMonthlyMicros) ||
          (limits.taskMicros !== undefined && !isAmount(limits.taskMicros))
        ) {
          throw new RangeError("a limit is a whole amount");
        }

        const organisation = periodKey(claim.organisationId);
        if ((used.get(organisation) ?? 0) + claim.micros > limits.organisationMonthlyMicros) {
          return Promise.resolve({ ok: false, limit: "organisation" });
        }
        const task =
          claim.taskId === undefined ? undefined : taskKey(claim.organisationId, claim.taskId);
        if (
          task !== undefined &&
          limits.taskMicros !== undefined &&
          (used.get(task) ?? 0) + claim.micros > limits.taskMicros
        ) {
          return Promise.resolve({ ok: false, limit: "task" });
        }

        // Both limits had room, and nothing here waits, so no other claim came between the check and this.
        add(organisation, claim.micros);
        if (task !== undefined) add(task, claim.micros);
        let open = true;
        const close = (charged: number): void => {
          if (!open) return;
          open = false;
          add(organisation, charged - claim.micros);
          if (task !== undefined) add(task, charged - claim.micros);
        };
        return Promise.resolve({
          ok: true,
          reservation: {
            settle: (charged) => {
              if (!isAmount(charged)) return Promise.reject(new RangeError("a charge is whole"));
              close(charged);
              return Promise.resolve();
            },
            release: () => {
              close(0);
              return Promise.resolve();
            },
          },
        });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error("ledger failed"));
      }
    },

    usedMicros(organisationId, taskId) {
      const key =
        taskId === undefined ? periodKey(organisationId) : taskKey(organisationId, taskId);
      return used.get(key) ?? 0;
    },
  };
}
