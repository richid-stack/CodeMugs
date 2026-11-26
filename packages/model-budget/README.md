# @codemugs/model-budget

The budget ledger of the [model gateway](../model-gateway/README.md), kept in PostgreSQL: spending limits that survive a restart and are the same for every process that uses the database, and usage kept for each organisation.

**Status:** Phase 1 · Foundation, step 8, part four ([ADR 0042](../../docs/architecture/decisions/0042-a-budget-ledger-in-postgresql.md)). The ledger exists and is tested against a real PostgreSQL, including claims made at once from two pools. **Nothing sets a limit yet** (so every organisation is refused until an operator inserts a row), there is no adapter for a real provider, and nothing calls the gateway. Release gate 17 is **in progress, not closed**.

## What it does

```ts
import { createModelGateway } from "@codemugs/model-gateway";
import { createPostgresBudget } from "@codemugs/model-budget";

const budget = createPostgresBudget({ pool }); // a pool for the application role
const gateway = createModelGateway({ providers, policy, budget });

await budget.usedMicros(organisationId); // spent this month (UTC), in millionths of a US dollar
await budget.usedMicros(organisationId, taskId); // spent by a task, over all months
```

- **`reserve(claim)`** takes room for one attempt, as the gateway asks, or says which limit is in the way (`organisation` or `task`). It runs as the organisation, under row-level security, in one transaction, **under a lock for the organisation**, so two claims that do not both fit are never both granted, whether they come from one process or from two.
- **`settle(charged, record?)`** and **`release()`** close a reservation once. A second call does nothing. The settle entry holds the difference from what was reserved, and the provider's name, the model's name, an outcome code and the token counts. **Nothing that was said is kept.**
- **A reservation that is never closed stays counted as spent, at its worst case.**
- **It fails closed.** A claim or charge that is not a whole amount, a task id that is not valid, a database that cannot be reached: each throws, and the gateway sends nothing (`budget_unavailable`).

## The tables

Migration 0010 adds `model_budgets` (one row for an organisation: a limit for the month and, optionally, one for each task, in whole millionths of a dollar) and `model_ledger_entries` (append-only: `reserve`, `settle` and `release` entries). The application role **can read the limits and cannot write them**, so a tenant cannot raise its own, and it can insert and read entries and never change or delete one.

**Setting a limit** is done by an operator with the migration login, for now by hand; there is no tool yet:

```sql
INSERT INTO model_budgets (organisation_id, monthly_micros, task_micros)
VALUES ('<organisation id>', 20000000, 2000000)
ON CONFLICT (organisation_id) DO UPDATE
  SET monthly_micros = EXCLUDED.monthly_micros,
      task_micros = EXCLUDED.task_micros,
      updated_at = now();
```

A change is taken at the next claim.

## Not shown

A real provider's billing against this ledger, a tool for operators to set limits, usage read through the API, a sweep for reservations that were never closed, and retention of old entries. The cost of the lock for a very busy organisation has not been measured.

## Tests

`CODEMUGS_TEST_DATABASE_URL=… pnpm --filter @codemugs/model-budget test` (skipped without a database; CI requires one). The tests use the real schema, as the application role.
