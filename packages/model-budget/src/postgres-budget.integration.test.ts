import { randomUUID } from "node:crypto";
import {
  createMockProvider,
  createModelGateway,
  ModelError,
  permitClasses,
  type BudgetGrant,
  type BudgetReservation,
} from "@codemugs/model-gateway";
import { withTenant } from "@codemugs/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createPostgresBudget } from "./postgres-budget.js";
import { describeDatabase, startHarness, type Harness } from "./test-harness.js";

interface EntryRow {
  kind: string;
  micros: string;
  period: string;
  task_id: string | null;
  provider: string | null;
  model: string | null;
  outcome: string | null;
  input_tokens: string | null;
  output_tokens: string | null;
}

describeDatabase("the budget ledger in PostgreSQL", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  /** An organisation with a budget, and a ledger over the first process's pool. */
  async function withBudget(monthly: number, task?: number) {
    const org = await h.createOrganisation("Org");
    await h.setBudget(org, monthly, task);
    return { org, budget: createPostgresBudget({ pool: h.app }) };
  }

  async function granted(work: Promise<BudgetGrant>): Promise<BudgetReservation> {
    const grant = await work;
    if (!grant.ok) throw new Error(`refused by the ${grant.limit} limit`);
    return grant.reservation;
  }

  async function entries(org: string): Promise<EntryRow[]> {
    const result = await h.admin.query<EntryRow>(
      `SELECT kind, micros::text, period::text, task_id, provider, model, outcome,
              input_tokens::text, output_tokens::text
         FROM model_ledger_entries WHERE organisation_id = $1 ORDER BY created_at, kind DESC`,
      [org],
    );
    return result.rows;
  }

  describe("reserving", () => {
    it("counts what is reserved as used, and refuses what does not fit, by one", async () => {
      const { org, budget } = await withBudget(1_000);
      await granted(budget.reserve({ organisationId: org, micros: 600 }));
      expect(await budget.usedMicros(org)).toBe(600);
      expect(await budget.reserve({ organisationId: org, micros: 401 })).toEqual({
        ok: false,
        limit: "organisation",
      });
      expect(await budget.usedMicros(org)).toBe(600);
      await granted(budget.reserve({ organisationId: org, micros: 400 }));
      expect(await budget.usedMicros(org)).toBe(1_000);
      expect((await entries(org)).map((row) => [row.kind, row.micros])).toEqual([
        ["reserve", "600"],
        ["reserve", "400"],
      ]);
    });

    it("writes the month and the task of the reservation, with no usage on it", async () => {
      const { org, budget } = await withBudget(1_000, 500);
      await granted(budget.reserve({ organisationId: org, taskId: "task-1", micros: 10 }));
      const [row] = await entries(org);
      expect(row).toMatchObject({
        kind: "reserve",
        micros: "10",
        task_id: "task-1",
        provider: null,
        model: null,
        outcome: null,
        input_tokens: null,
        output_tokens: null,
      });
      const month = await h.admin.query<{ period: string }>(
        "SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date::text AS period",
      );
      expect(row?.period).toBe(month.rows[0]?.period);
    });

    it("refuses an organisation that has no budget, and one whose budget is nothing", async () => {
      const bare = await h.createOrganisation("Bare");
      const budget = createPostgresBudget({ pool: h.app });
      expect(await budget.reserve({ organisationId: bare, micros: 0 })).toEqual({
        ok: false,
        limit: "organisation",
      });
      const none = await withBudget(0);
      expect((await none.budget.reserve({ organisationId: none.org, micros: 1 })).ok).toBe(false);
      expect((await none.budget.reserve({ organisationId: none.org, micros: 0 })).ok).toBe(true);
    });

    it("does not count an earlier month, and takes a limit changed by an operator at the next claim", async () => {
      const { org, budget } = await withBudget(1_000);
      await h.admin.query(
        `INSERT INTO model_ledger_entries (organisation_id, id, reservation_id, kind, period, micros)
         VALUES ($1, $2, $3, 'reserve', (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date, 1000)`,
        [org, randomUUID(), randomUUID()],
      );
      expect(await budget.usedMicros(org)).toBe(0);
      await granted(budget.reserve({ organisationId: org, micros: 1_000 }));
      expect((await budget.reserve({ organisationId: org, micros: 1 })).ok).toBe(false);
      await h.setBudget(org, 1_500);
      await granted(budget.reserve({ organisationId: org, micros: 500 }));
      await h.setBudget(org, 100);
      expect((await budget.reserve({ organisationId: org, micros: 0 })).ok).toBe(false);
    });

    it("keeps organisations apart", async () => {
      const a = await withBudget(100);
      const b = await withBudget(5_000);
      await granted(a.budget.reserve({ organisationId: a.org, micros: 100 }));
      expect((await a.budget.reserve({ organisationId: a.org, micros: 1 })).ok).toBe(false);
      await granted(b.budget.reserve({ organisationId: b.org, micros: 4_000 }));
      expect(await a.budget.usedMicros(a.org)).toBe(100);
      expect(await b.budget.usedMicros(b.org)).toBe(4_000);
    });

    it("limits a task over all months, with the refusal naming the task, and no other task or call", async () => {
      const { org, budget } = await withBudget(10_000, 500);
      await h.admin.query(
        `INSERT INTO model_ledger_entries (organisation_id, id, reservation_id, kind, period, task_id, micros)
         VALUES ($1, $2, $3, 'reserve', (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '2 month')::date, 't1', 300)`,
        [org, randomUUID(), randomUUID()],
      );
      expect(await budget.usedMicros(org, "t1")).toBe(300);
      expect(await budget.usedMicros(org)).toBe(0);
      expect(await budget.reserve({ organisationId: org, taskId: "t1", micros: 201 })).toEqual({
        ok: false,
        limit: "task",
      });
      await granted(budget.reserve({ organisationId: org, taskId: "t1", micros: 200 }));
      await granted(budget.reserve({ organisationId: org, taskId: "t2", micros: 500 }));
      await granted(budget.reserve({ organisationId: org, micros: 5_000 }));
      expect(await budget.usedMicros(org, "t1")).toBe(500);
    });

    it("names the organisation's limit when both are in the way, and takes nothing for a refused claim", async () => {
      const { org, budget } = await withBudget(400, 300);
      await granted(budget.reserve({ organisationId: org, taskId: "t1", micros: 300 }));
      expect(await budget.reserve({ organisationId: org, taskId: "t2", micros: 200 })).toEqual({
        ok: false,
        limit: "organisation",
      });
      expect(await budget.reserve({ organisationId: org, taskId: "t1", micros: 200 })).toEqual({
        ok: false,
        limit: "organisation",
      });
      expect(await entries(org)).toHaveLength(1);
    });

    it("does not let claims that together do not fit both be granted, from one process or from two", async () => {
      const { org } = await withBudget(500);
      const first = createPostgresBudget({ pool: h.app });
      const second = createPostgresBudget({ pool: h.otherApp });
      const grants = await Promise.all(
        Array.from({ length: 80 }, (_, i) =>
          (i % 2 === 0 ? first : second).reserve({ organisationId: org, micros: 10 }),
        ),
      );
      expect(grants.filter((grant) => grant.ok)).toHaveLength(50);
      expect(await first.usedMicros(org)).toBe(500);
    }, 30_000);

    it("takes an organisation's id in capitals and in lower case for one organisation, and does not let their claims pass each other", async () => {
      const { org } = await withBudget(500);
      const first = createPostgresBudget({ pool: h.app });
      const second = createPostgresBudget({ pool: h.otherApp });
      const grants = await Promise.all(
        Array.from({ length: 80 }, (_, i) =>
          (i % 2 === 0 ? first : second).reserve({
            organisationId: i % 2 === 0 ? org.toLowerCase() : org.toUpperCase(),
            micros: 10,
          }),
        ),
      );
      expect(grants.filter((grant) => grant.ok)).toHaveLength(50);
      expect(await first.usedMicros(org)).toBe(500);
    }, 30_000);

    it("makes one lock of an organisation's id whichever way it is spelled", async () => {
      const { org, budget } = await withBudget(1_000);
      // Another transaction holds the organisation's lock, as a claim in the middle of its check does.
      const holder = await h.admin.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `codemugs:model_budget:${org.toLowerCase()}`,
        ]);
        for (const spelling of [org.toLowerCase(), org.toUpperCase()]) {
          const claim = budget.reserve({ organisationId: spelling, micros: 1 });
          const outcome = await Promise.race([
            claim.then(() => "went through"),
            new Promise<string>((resolve) => setTimeout(() => resolve("waited"), 300)),
          ]);
          expect(outcome).toBe("waited");
          await holder.query("COMMIT");
          expect((await claim).ok).toBe(true);
          await holder.query("BEGIN");
          await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            `codemugs:model_budget:${org.toLowerCase()}`,
          ]);
        }
        await holder.query("COMMIT");
      } finally {
        holder.release();
      }
    });

    it("fails, and grants nothing, when the ledger says that less than nothing has been spent", async () => {
      const month = await withBudget(1_000, 1_000);
      const thisMonth = "date_trunc('month', now() AT TIME ZONE 'UTC')::date";
      const lastMonth =
        "(date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date";
      const standalone = (org: string, period: string, task: string | null) =>
        h.admin.query(
          `INSERT INTO model_ledger_entries (organisation_id, id, reservation_id, kind, period, task_id, micros)
           VALUES ($1, $2, $3, 'settle', ${period}, $4, -1)`,
          [org, randomUUID(), randomUUID(), task],
        );
      await standalone(month.org, thisMonth, null);
      await expect(
        month.budget.reserve({ organisationId: month.org, micros: 1 }),
      ).rejects.toThrow();
      const task = await withBudget(1_000, 1_000);
      await standalone(task.org, lastMonth, "t1");
      await expect(
        task.budget.reserve({ organisationId: task.org, taskId: "t1", micros: 1 }),
      ).rejects.toThrow();
      // The month's sum is not negative, so a claim with no task is not in the way of it.
      await granted(task.budget.reserve({ organisationId: task.org, micros: 1 }));
      expect(await entries(month.org)).toHaveLength(1);
    });

    it("fails, and takes nothing, for a claim that is not whole, a task id that is not valid, or an organisation that is not an id", async () => {
      const { org, budget } = await withBudget(1_000);
      for (const micros of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
        await expect(budget.reserve({ organisationId: org, micros })).rejects.toThrow();
      }
      for (const taskId of ["", "a b", "x".repeat(65), "t'; DROP TABLE organisations; --"]) {
        await expect(budget.reserve({ organisationId: org, taskId, micros: 1 })).rejects.toThrow();
      }
      await expect(budget.reserve({ organisationId: "not an id", micros: 1 })).rejects.toThrow();
      expect(await entries(org)).toEqual([]);
    });
  });

  describe("closing a reservation", () => {
    it("gives room back for what a settled attempt did not cost, and takes more if it cost more", async () => {
      const { org, budget } = await withBudget(1_000);
      const first = await granted(budget.reserve({ organisationId: org, micros: 600 }));
      await first.settle(100);
      expect(await budget.usedMicros(org)).toBe(100);
      const second = await granted(budget.reserve({ organisationId: org, micros: 500 }));
      await second.settle(900);
      expect(await budget.usedMicros(org)).toBe(1_000);
      expect((await entries(org)).map((row) => [row.kind, row.micros])).toEqual([
        ["reserve", "600"],
        ["settle", "-500"],
        ["reserve", "500"],
        ["settle", "400"],
      ]);
    });

    it("gives back everything when released", async () => {
      const { org, budget } = await withBudget(1_000);
      const reservation = await granted(budget.reserve({ organisationId: org, micros: 700 }));
      await reservation.release();
      expect(await budget.usedMicros(org)).toBe(0);
      expect((await entries(org)).map((row) => [row.kind, row.micros])).toEqual([
        ["reserve", "700"],
        ["release", "-700"],
      ]);
    });

    it("closes a reservation once: a second settle or release adds nothing", async () => {
      const { org, budget } = await withBudget(1_000);
      const settled = await granted(budget.reserve({ organisationId: org, micros: 300 }));
      await settled.settle(100);
      await settled.settle(900);
      await settled.release();
      expect(await budget.usedMicros(org)).toBe(100);
      const released = await granted(budget.reserve({ organisationId: org, micros: 300 }));
      await released.release();
      await released.release();
      await released.settle(500);
      expect(await budget.usedMicros(org)).toBe(100);
      expect(await entries(org)).toHaveLength(4);
    });

    it("closes it once when it is closed at the same time from two processes", async () => {
      const { org, budget } = await withBudget(1_000);
      const reservation = await granted(budget.reserve({ organisationId: org, micros: 300 }));
      const other = await granted(
        createPostgresBudget({ pool: h.otherApp }).reserve({ organisationId: org, micros: 0 }),
      );
      await other.release();
      await Promise.all([reservation.settle(50), reservation.settle(250), reservation.release()]);
      const closing = (await entries(org)).filter(
        (row) => row.micros !== "0" && row.kind !== "reserve",
      );
      expect(closing).toHaveLength(1);
    });

    it("leaves a reservation that is not closed counted as spent, at its worst case", async () => {
      const { org, budget } = await withBudget(1_000);
      await granted(budget.reserve({ organisationId: org, micros: 900 }));
      expect(await budget.usedMicros(org)).toBe(900);
      expect((await budget.reserve({ organisationId: org, micros: 200 })).ok).toBe(false);
    });

    it("counts a charge in the month in which the reservation was made", async () => {
      const { org, budget } = await withBudget(1_000);
      const reservationId = randomUUID();
      await h.admin.query(
        `INSERT INTO model_ledger_entries (organisation_id, id, reservation_id, kind, period, micros)
         VALUES ($1, $2, $3, 'reserve', (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date, 400)`,
        [org, randomUUID(), reservationId],
      );
      // A reservation that was made last month, closed this month, by one that only has its id.
      const settle = await h.admin.query(
        `INSERT INTO model_ledger_entries (organisation_id, id, reservation_id, kind, period, micros)
         SELECT organisation_id, $3, reservation_id, 'settle', period, 150 - micros
           FROM model_ledger_entries WHERE organisation_id = $1 AND reservation_id = $2 AND kind = 'reserve'`,
        [org, reservationId, randomUUID()],
      );
      expect(settle.rowCount).toBe(1);
      expect(await budget.usedMicros(org)).toBe(0);
      await granted(budget.reserve({ organisationId: org, micros: 1_000 }));
    });

    it("charges a settle to the month in which the reservation was made, when it is closed in another", async () => {
      const { org, budget } = await withBudget(1_000);
      const reservation = await granted(budget.reserve({ organisationId: org, micros: 400 }));
      // The reservation was made last month: the operator's login moves its entry back a month.
      await h.admin.query(
        `UPDATE model_ledger_entries
            SET period = (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date
          WHERE organisation_id = $1`,
        [org],
      );
      expect(await budget.usedMicros(org)).toBe(0);
      await reservation.settle(150);
      expect(await budget.usedMicros(org)).toBe(0);
      const last = await h.admin.query<{ kind: string; micros: string; same: boolean }>(
        `SELECT kind, micros::text,
                period = (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date AS same
           FROM model_ledger_entries WHERE organisation_id = $1 ORDER BY kind DESC`,
        [org],
      );
      expect(last.rows).toEqual([
        { kind: "settle", micros: "-250", same: true },
        { kind: "reserve", micros: "400", same: true },
      ]);
    });

    it("refuses to report a sum that cannot be right, which only an operator can make", async () => {
      const { org, budget } = await withBudget(1_000);
      await h.admin.query(
        `INSERT INTO model_ledger_entries (organisation_id, id, reservation_id, kind, period, micros)
         VALUES ($1, $2, $3, 'settle', date_trunc('month', now() AT TIME ZONE 'UTC')::date, -5)`,
        [org, randomUUID(), randomUUID()],
      );
      await expect(budget.usedMicros(org)).rejects.toThrow();
    });

    it("keeps what the attempt was, and nothing that was said, and keeps nothing when it is released", async () => {
      const { org, budget } = await withBudget(10_000);
      const one = await granted(budget.reserve({ organisationId: org, taskId: "t1", micros: 500 }));
      await one.settle(120, {
        provider: "claude",
        model: "a-model",
        outcome: "ok",
        inputTokens: 700,
        outputTokens: 30,
      });
      const two = await granted(budget.reserve({ organisationId: org, micros: 500 }));
      await two.settle(500, { provider: "claude", model: "a-model", outcome: "timeout" });
      const three = await granted(budget.reserve({ organisationId: org, micros: 500 }));
      await three.settle(1);
      const four = await granted(budget.reserve({ organisationId: org, micros: 500 }));
      await four.release();
      const rows = await entries(org);
      const settles = rows.filter((row) => row.kind === "settle");
      expect(
        settles.map((row) => [
          row.provider,
          row.model,
          row.outcome,
          row.input_tokens,
          row.output_tokens,
          row.task_id,
        ]),
      ).toEqual([
        ["claude", "a-model", "ok", "700", "30", "t1"],
        ["claude", "a-model", "timeout", null, null, null],
        [null, null, null, null, null, null],
      ]);
      const release = rows.find((row) => row.kind === "release");
      expect(release).toMatchObject({ provider: null, model: null, outcome: null });
    });

    it("fails for a charge that is not whole, and the reservation stays open", async () => {
      const { org, budget } = await withBudget(1_000);
      const reservation = await granted(budget.reserve({ organisationId: org, micros: 300 }));
      for (const charged of [-1, 0.5, Number.NaN]) {
        await expect(reservation.settle(charged)).rejects.toThrow();
      }
      expect(await budget.usedMicros(org)).toBe(300);
      await reservation.settle(120);
      expect(await budget.usedMicros(org)).toBe(120);
    });

    it("fails, and keeps the reservation counted, for a record that the ledger will not keep", async () => {
      const { org, budget } = await withBudget(1_000);
      const reservation = await granted(budget.reserve({ organisationId: org, micros: 300 }));
      await expect(
        reservation.settle(100, { provider: "a", model: "m".repeat(201), outcome: "ok" }),
      ).rejects.toThrow();
      await expect(
        reservation.settle(100, { provider: "a", model: "m", outcome: "Not A Code" }),
      ).rejects.toThrow();
      expect(await budget.usedMicros(org)).toBe(300);
    });

    it("cannot close another organisation's reservation, though it has its id", async () => {
      const a = await withBudget(1_000);
      const b = await withBudget(1_000);
      const reservation = await granted(a.budget.reserve({ organisationId: a.org, micros: 400 }));
      const ids = await h.admin.query<{ reservation_id: string }>(
        "SELECT reservation_id FROM model_ledger_entries WHERE organisation_id = $1",
        [a.org],
      );
      const reservationId = ids.rows[0]?.reservation_id;
      // The id of A's reservation, tried as B: row-level security shows B no such reservation.
      const stolen = await withTenant(h.app, b.org, (db) =>
        db.query(
          `INSERT INTO model_ledger_entries (organisation_id, id, reservation_id, kind, period, micros)
           SELECT organisation_id, $2, reservation_id, 'release', period, -micros
             FROM model_ledger_entries WHERE reservation_id = $1 AND kind = 'reserve'`,
          [reservationId, randomUUID()],
        ),
      );
      expect(stolen.rowCount).toBe(0);
      expect(await a.budget.usedMicros(a.org)).toBe(400);
      await reservation.release();
      expect(await a.budget.usedMicros(a.org)).toBe(0);
    });
  });

  describe("who may write what", () => {
    it("lets the application read its budget and not write it, so that a tenant cannot raise its own limit", async () => {
      const { org } = await withBudget(1_000);
      const read = await withTenant(h.app, org, (db) =>
        db.query<{ monthly_micros: string }>("SELECT monthly_micros::text FROM model_budgets"),
      );
      expect(read.rows).toEqual([{ monthly_micros: "1000" }]);
      for (const statement of [
        "UPDATE model_budgets SET monthly_micros = 999999999",
        "DELETE FROM model_budgets",
        "INSERT INTO model_budgets (organisation_id, monthly_micros) VALUES (gen_random_uuid(), 1)",
      ]) {
        await expect(withTenant(h.app, org, (db) => db.query(statement))).rejects.toMatchObject({
          code: "42501",
        });
      }
    });

    it("does not let the application change or delete the ledger", async () => {
      const { org, budget } = await withBudget(1_000);
      await granted(budget.reserve({ organisationId: org, micros: 100 }));
      for (const statement of [
        "UPDATE model_ledger_entries SET micros = 0",
        "DELETE FROM model_ledger_entries",
        "TRUNCATE model_ledger_entries",
      ]) {
        await expect(withTenant(h.app, org, (db) => db.query(statement))).rejects.toMatchObject({
          code: "42501",
        });
      }
      expect(await budget.usedMicros(org)).toBe(100);
    });

    it("shows a tenant its own entries and budget only", async () => {
      const a = await withBudget(1_000);
      const b = await withBudget(2_000);
      await granted(a.budget.reserve({ organisationId: a.org, micros: 100 }));
      const seen = await withTenant(h.app, b.org, async (db) => ({
        entries: (await db.query("SELECT 1 FROM model_ledger_entries")).rowCount,
        budgets: (
          await db.query<{ monthly_micros: string }>(
            "SELECT monthly_micros::text FROM model_budgets",
          )
        ).rows,
      }));
      expect(seen.entries).toBe(0);
      expect(seen.budgets).toEqual([{ monthly_micros: "2000" }]);
    });

    it("refuses an entry for another organisation, and a task id or a usage that is not valid", async () => {
      const a = await withBudget(1_000);
      const b = await withBudget(1_000);
      const insert = (org: string, as: string, extra = "") =>
        withTenant(h.app, as, (db) =>
          db.query(
            `INSERT INTO model_ledger_entries (organisation_id, id, reservation_id, kind, period, micros${extra ? ", " + extra.split("=")[0] : ""})
             VALUES ($1, gen_random_uuid(), gen_random_uuid(), 'reserve', date_trunc('month', now() AT TIME ZONE 'UTC')::date, 1${extra ? ", " + extra.split("=")[1] : ""})`,
            [org],
          ),
        );
      await expect(insert(a.org, b.org)).rejects.toMatchObject({ code: "42501" });
      await expect(insert(a.org, a.org, "task_id='bad id'")).rejects.toMatchObject({
        code: "23514",
      });
      await expect(insert(a.org, a.org, "provider='x'")).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("under the gateway", () => {
    const shape = z.object({ summary: z.string() });
    const request = {
      task: "diagnose",
      instructions: "Say what is wrong.",
      data: [],
      output: shape,
      maxOutputTokens: 500,
    };

    it("stops work when the money does, for every process that shares the ledger, and keeps what each call was", async () => {
      const org = await h.createOrganisation("Org");
      // Measure first: what a call is reserved for, and what it costs.
      const probe = createMockProvider({ name: "probe", steps: [{ value: { summary: "x" } }] });
      await h.setBudget(org, 1_000_000_000);
      const measured = await createModelGateway({
        providers: [probe],
        policy: permitClasses([]),
        budget: createPostgresBudget({ pool: h.app }),
      }).call({ organisationId: org }, request);
      const rows = await entries(org);
      const worst = Number(rows[0]?.micros);
      const actual = measured.costMicros;
      expect(rows.map((row) => row.kind)).toEqual(["reserve", "settle"]);
      expect(rows[1]).toMatchObject({
        provider: "probe",
        model: "mock-model",
        outcome: "ok",
        input_tokens: String(measured.inputTokens),
        output_tokens: String(measured.outputTokens),
      });
      expect(worst + Number(rows[1]?.micros)).toBe(actual);

      // Room for two more calls and not a third: the measured call is spent, each of the next two is
      // reserved for its worst case and then costs `actual`, and the third would need one more than
      // is left. Two processes make one call each.
      expect(actual).toBeGreaterThan(0);
      await h.setBudget(org, 3 * actual + worst - 1);
      const one = createMockProvider({ name: "one", steps: [{ value: { summary: "x" } }] });
      const two = createMockProvider({ name: "two", steps: [{ value: { summary: "x" } }] });
      const first = createModelGateway({
        providers: [one],
        policy: permitClasses([]),
        budget: createPostgresBudget({ pool: h.app }),
      });
      const second = createModelGateway({
        providers: [two],
        policy: permitClasses([]),
        budget: createPostgresBudget({ pool: h.otherApp }),
      });
      await first.call({ organisationId: org }, request);
      await second.call({ organisationId: org }, request);
      const refused = await first.call({ organisationId: org }, request).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(ModelError);
      expect((refused as ModelError).code).toBe("budget_exceeded");
      expect(one.calls).toHaveLength(1);
      expect(two.calls).toHaveLength(1);
      const spent = await createPostgresBudget({ pool: h.app }).usedMicros(org);
      expect(spent).toBe(3 * actual);
    }, 30_000);

    it("keeps what a call that cost nothing was", async () => {
      const org = await h.createOrganisation("Org");
      await h.setBudget(org, 1_000_000);
      const free = createMockProvider({
        name: "free",
        model: "free-model",
        price: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
        steps: [{ value: { summary: "x" } }],
      });
      const result = await createModelGateway({
        providers: [free],
        policy: permitClasses([]),
        budget: createPostgresBudget({ pool: h.app }),
      }).call({ organisationId: org }, request);
      expect(result.costMicros).toBe(0);
      expect(
        (await entries(org)).map((row) => [
          row.kind,
          row.micros,
          row.provider,
          row.model,
          row.outcome,
          row.input_tokens,
          row.output_tokens,
        ]),
      ).toEqual([
        ["reserve", "0", null, null, null, null, null],
        [
          "settle",
          "0",
          "free",
          "free-model",
          "ok",
          String(result.inputTokens),
          String(result.outputTokens),
        ],
      ]);
    });

    it("sends nothing when the ledger cannot be read", async () => {
      const broken = createPostgresBudget({
        pool: { connect: () => Promise.reject(new Error("db.internal is down")) } as never,
      });
      const org = randomUUID();
      const answering = createMockProvider({ steps: [{ value: { summary: "x" } }] });
      const error = await createModelGateway({
        providers: [answering],
        policy: permitClasses([]),
        budget: broken,
      })
        .call({ organisationId: org }, request)
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect((error as ModelError).code).toBe("budget_unavailable");
      expect(answering.calls).toHaveLength(0);
      expect(JSON.stringify(error) + (error as ModelError).message).not.toContain("db.internal");
    });
  });
});
