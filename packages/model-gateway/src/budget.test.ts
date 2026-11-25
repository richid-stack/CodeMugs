import { describe, expect, it } from "vitest";
import {
  createMemoryBudget,
  unlimitedBudget,
  type BudgetGrant,
  type BudgetLimits,
  type BudgetReservation,
} from "./budget.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function ledger(limits: BudgetLimits | null = { organisationMonthlyMicros: 1_000 }) {
  const clock = { now: Date.UTC(2026, 10, 15, 12) };
  const budget = createMemoryBudget({
    limits: () => limits ?? undefined,
    now: () => clock.now,
  });
  return { budget, clock };
}

async function granted(work: Promise<BudgetGrant>): Promise<BudgetReservation> {
  const grant = await work;
  if (!grant.ok) throw new Error(`refused by the ${grant.limit} limit`);
  return grant.reservation;
}

describe("the budget ledger in memory", () => {
  it("counts what is reserved as used, and refuses what does not fit, by one", async () => {
    const { budget } = ledger({ organisationMonthlyMicros: 1_000 });
    await granted(budget.reserve({ organisationId: A, micros: 600 }));
    expect(budget.usedMicros(A)).toBe(600);
    expect(await budget.reserve({ organisationId: A, micros: 401 })).toEqual({
      ok: false,
      limit: "organisation",
    });
    expect(budget.usedMicros(A)).toBe(600);
    await granted(budget.reserve({ organisationId: A, micros: 400 }));
    expect(budget.usedMicros(A)).toBe(1_000);
  });

  it("gives room back for what a settled attempt did not cost, and takes more if it cost more", async () => {
    const { budget } = ledger({ organisationMonthlyMicros: 1_000 });
    const first = await granted(budget.reserve({ organisationId: A, micros: 600 }));
    await first.settle(100);
    expect(budget.usedMicros(A)).toBe(100);
    const second = await granted(budget.reserve({ organisationId: A, micros: 500 }));
    await second.settle(900);
    // The charge is what happened, so it can pass the limit; the next claim is the one that is refused.
    expect(budget.usedMicros(A)).toBe(1_000);
    const third = await granted(budget.reserve({ organisationId: A, micros: 0 }));
    await third.settle(50);
    expect(budget.usedMicros(A)).toBe(1_050);
    expect((await budget.reserve({ organisationId: A, micros: 0 })).ok).toBe(false);
  });

  it("gives back everything when released", async () => {
    const { budget } = ledger();
    const reservation = await granted(budget.reserve({ organisationId: A, micros: 700 }));
    await reservation.release();
    expect(budget.usedMicros(A)).toBe(0);
  });

  it("does nothing the second time a reservation is settled or released, so that nothing is given back twice", async () => {
    const { budget } = ledger();
    const settled = await granted(budget.reserve({ organisationId: A, micros: 300 }));
    await settled.settle(100);
    await settled.settle(900);
    await settled.release();
    expect(budget.usedMicros(A)).toBe(100);

    const released = await granted(budget.reserve({ organisationId: A, micros: 300 }));
    await released.release();
    await released.release();
    await released.settle(500);
    expect(budget.usedMicros(A)).toBe(100);
  });

  it("leaves a reservation that is not settled counted as spent, at its worst case", async () => {
    const { budget } = ledger({ organisationMonthlyMicros: 1_000 });
    await granted(budget.reserve({ organisationId: A, micros: 900 }));
    expect(budget.usedMicros(A)).toBe(900);
    expect((await budget.reserve({ organisationId: A, micros: 200 })).ok).toBe(false);
  });

  it("refuses an organisation whose limits nobody set, and a limit of nothing", async () => {
    const { budget } = ledger(null);
    expect(await budget.reserve({ organisationId: A, micros: 0 })).toEqual({
      ok: false,
      limit: "organisation",
    });
    const zero = ledger({ organisationMonthlyMicros: 0 }).budget;
    expect((await zero.reserve({ organisationId: A, micros: 1 })).ok).toBe(false);
    expect((await zero.reserve({ organisationId: A, micros: 0 })).ok).toBe(true);
  });

  it("keeps organisations apart, with limits of their own", async () => {
    const clock = { now: Date.UTC(2026, 10, 15) };
    const budget = createMemoryBudget({
      limits: (id) => ({ organisationMonthlyMicros: id === A ? 100 : 5_000 }),
      now: () => clock.now,
    });
    await granted(budget.reserve({ organisationId: A, micros: 100 }));
    expect((await budget.reserve({ organisationId: A, micros: 1 })).ok).toBe(false);
    await granted(budget.reserve({ organisationId: B, micros: 4_000 }));
    expect(budget.usedMicros(A)).toBe(100);
    expect(budget.usedMicros(B)).toBe(4_000);
  });

  it("starts again each calendar month in UTC, and counts a charge in the month in which it was reserved", async () => {
    const { budget, clock } = ledger({ organisationMonthlyMicros: 1_000 });
    clock.now = Date.UTC(2026, 10, 30, 23, 59, 59);
    const late = await granted(budget.reserve({ organisationId: A, micros: 1_000 }));
    expect((await budget.reserve({ organisationId: A, micros: 1 })).ok).toBe(false);
    clock.now = Date.UTC(2026, 11, 1, 0, 0, 0);
    expect(budget.usedMicros(A)).toBe(0);
    await granted(budget.reserve({ organisationId: A, micros: 1_000 }));
    await late.settle(400);
    expect(budget.usedMicros(A)).toBe(1_000);
    clock.now = Date.UTC(2026, 10, 30, 23, 59, 59);
    expect(budget.usedMicros(A)).toBe(400);
  });

  describe("a task", () => {
    const limits = { organisationMonthlyMicros: 10_000, taskMicros: 500 };

    it("has a limit of its own, and the refusal says that it is the task's", async () => {
      const { budget } = ledger(limits);
      await granted(budget.reserve({ organisationId: A, taskId: "t1", micros: 300 }));
      expect(await budget.reserve({ organisationId: A, taskId: "t1", micros: 201 })).toEqual({
        ok: false,
        limit: "task",
      });
      await granted(budget.reserve({ organisationId: A, taskId: "t1", micros: 200 }));
      expect(budget.usedMicros(A, "t1")).toBe(500);
    });

    it("does not limit another task, or a call that is not part of one", async () => {
      const { budget } = ledger(limits);
      await granted(budget.reserve({ organisationId: A, taskId: "t1", micros: 500 }));
      await granted(budget.reserve({ organisationId: A, taskId: "t2", micros: 500 }));
      await granted(budget.reserve({ organisationId: A, micros: 5_000 }));
      expect(budget.usedMicros(A, "t1")).toBe(500);
      expect(budget.usedMicros(A, "t2")).toBe(500);
      expect(budget.usedMicros(A)).toBe(6_000);
    });

    it("is the organisation's own, so that the same id of another organisation is another task", async () => {
      const { budget } = ledger(limits);
      await granted(budget.reserve({ organisationId: A, taskId: "t1", micros: 500 }));
      await granted(budget.reserve({ organisationId: B, taskId: "t1", micros: 500 }));
    });

    it("counts against the organisation's budget as well, and the organisation's limit is the one named when both are in the way", async () => {
      const { budget } = ledger({ organisationMonthlyMicros: 400, taskMicros: 300 });
      await granted(budget.reserve({ organisationId: A, taskId: "t1", micros: 300 }));
      expect(budget.usedMicros(A)).toBe(300);
      expect(await budget.reserve({ organisationId: A, taskId: "t2", micros: 200 })).toEqual({
        ok: false,
        limit: "organisation",
      });
      expect(await budget.reserve({ organisationId: A, taskId: "t1", micros: 200 })).toEqual({
        ok: false,
        limit: "organisation",
      });
    });

    it("is not charged for a claim that the organisation's limit refused, or the organisation for one that the task's refused", async () => {
      const { budget } = ledger({ organisationMonthlyMicros: 400, taskMicros: 300 });
      await budget.reserve({ organisationId: A, taskId: "t1", micros: 500 });
      expect(budget.usedMicros(A, "t1")).toBe(0);
      expect(budget.usedMicros(A)).toBe(0);
      await granted(budget.reserve({ organisationId: A, taskId: "t2", micros: 300 }));
      await budget.reserve({ organisationId: A, taskId: "t2", micros: 100 });
      expect(budget.usedMicros(A)).toBe(300);
      expect(budget.usedMicros(A, "t2")).toBe(300);
    });

    it("gets room back, as the organisation does, when an attempt is settled or released", async () => {
      const { budget } = ledger(limits);
      const one = await granted(budget.reserve({ organisationId: A, taskId: "t1", micros: 400 }));
      await one.settle(50);
      expect(budget.usedMicros(A, "t1")).toBe(50);
      expect(budget.usedMicros(A)).toBe(50);
      const two = await granted(budget.reserve({ organisationId: A, taskId: "t1", micros: 450 }));
      await two.release();
      expect(budget.usedMicros(A, "t1")).toBe(50);
      expect(budget.usedMicros(A)).toBe(50);
    });
  });

  it("does not let claims that together do not fit both be granted, when they are made at once", async () => {
    const { budget } = ledger({ organisationMonthlyMicros: 500 });
    const grants = await Promise.all(
      Array.from({ length: 100 }, () => budget.reserve({ organisationId: A, micros: 10 })),
    );
    expect(grants.filter((grant) => grant.ok)).toHaveLength(50);
    expect(budget.usedMicros(A)).toBe(500);
  });

  it("fails, and takes nothing, for a claim or a limit that is not a whole amount", async () => {
    const { budget } = ledger({ organisationMonthlyMicros: 1_000 });
    for (const micros of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      await expect(budget.reserve({ organisationId: A, micros })).rejects.toThrow();
    }
    for (const bad of [
      { organisationMonthlyMicros: -1 },
      { organisationMonthlyMicros: 1.5 },
      { organisationMonthlyMicros: 1_000, taskMicros: -5 },
      { organisationMonthlyMicros: 1_000, taskMicros: Number.NaN },
    ]) {
      const broken = ledger(bad).budget;
      await expect(broken.reserve({ organisationId: A, taskId: "t", micros: 1 })).rejects.toThrow();
    }
    expect(budget.usedMicros(A)).toBe(0);
  });

  it("fails when it is given a limit function that fails, or a time that is not one", async () => {
    const throwing = createMemoryBudget({
      limits: () => {
        throw new Error("no limits");
      },
    });
    await expect(throwing.reserve({ organisationId: A, micros: 1 })).rejects.toThrow();
    const badTime = createMemoryBudget({
      limits: () => ({ organisationMonthlyMicros: 10 }),
      now: () => Number.NaN,
    });
    await expect(badTime.reserve({ organisationId: A, micros: 1 })).rejects.toThrow();
  });

  it("keeps a reservation open when it is settled with a charge that is not a whole amount", async () => {
    const { budget } = ledger();
    const reservation = await granted(budget.reserve({ organisationId: A, micros: 300 }));
    for (const charged of [-1, 0.5, Number.NaN]) {
      await expect(reservation.settle(charged)).rejects.toThrow();
    }
    expect(budget.usedMicros(A)).toBe(300);
    await reservation.settle(120);
    expect(budget.usedMicros(A)).toBe(120);
  });
});

describe("the ledger that has no limit", () => {
  it("grants everything, and settling it does nothing", async () => {
    const budget = unlimitedBudget();
    const reservation = await granted(
      budget.reserve({ organisationId: A, micros: Number.MAX_SAFE_INTEGER }),
    );
    await reservation.settle(5);
    await reservation.release();
  });
});
