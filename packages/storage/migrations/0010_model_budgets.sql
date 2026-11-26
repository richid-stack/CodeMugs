-- 0010: what model calls may cost, and what they did cost. See ADR 0042 (and 0041).
--
-- Two tables.
--
-- model_budgets says how much an organisation may spend on model calls: for each calendar month
-- (UTC) and, if it has one, for each task. It decides what a tenant is allowed to spend, so it is
-- written by an operator, with the migration login, and the application role can only READ it. A
-- tenant (or a bug that acts for one) that could write it would be able to raise its own limit.
-- An organisation with no row has no budget, and is refused.
--
-- model_ledger_entries is the ledger. It is only ever appended to, and the application role can
-- only insert and read. A reservation is a 'reserve' entry for the most that a call can cost; what
-- the call did cost is added as one more entry, a 'settle' for the difference (what it was charged
-- less what was reserved) or a 'release' (all of it given back). What is spent is the sum of the
-- entries, so a reservation that is never closed (the process died) stays counted at its worst
-- case, and nothing is ever edited into saying that less was spent. A reservation is closed once:
-- a second 'settle' or 'release' for it cannot be inserted.
--
-- The month (period) is the one in which the reservation was made, and is chosen by the database's
-- clock, and its closing entry carries the same one. A task's spend is counted over all months.
--
-- A 'settle' also says what the attempt was (which provider and model, what came of it, how many
-- tokens) so that usage can be read per organisation. It holds no prompt, no answer and no message
-- of a provider: only names, a code and counts.

CREATE TABLE model_budgets (
  organisation_id uuid PRIMARY KEY REFERENCES organisations (id) ON DELETE RESTRICT,
  -- Millionths of a US dollar, for each calendar month (UTC). 0 is allowed and stops everything.
  monthly_micros  bigint NOT NULL CHECK (monthly_micros >= 0),
  -- For each task id. No limit on tasks if null.
  task_micros     bigint CHECK (task_micros >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_ledger_entries (
  organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
  id              uuid NOT NULL,
  -- The reservation that the entry belongs to: the same for its 'reserve' and its closing entry.
  reservation_id  uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('reserve', 'settle', 'release')),
  -- The first day of the calendar month (UTC) in which the reservation was made.
  period          date NOT NULL CHECK (extract(day FROM period) = 1),
  -- An opaque id of the task, as the gateway accepts it.
  task_id         text CHECK (task_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- A change to what is counted as spent, in millionths of a US dollar. A reservation adds what it
  -- reserves; a release takes all of it back; a settle adds what the call was charged less what
  -- was reserved, which may be either sign.
  micros          bigint NOT NULL,
  provider        text CHECK (length(provider) BETWEEN 1 AND 64),
  model           text CHECK (length(model) BETWEEN 1 AND 200),
  outcome         text CHECK (outcome ~ '^[a-z_]{1,40}$'),
  input_tokens    bigint CHECK (input_tokens >= 0),
  output_tokens   bigint CHECK (output_tokens >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, id),
  CHECK (kind <> 'reserve' OR micros >= 0),
  CHECK (kind <> 'release' OR micros <= 0),
  -- What the attempt was is said by a settle, and by nothing else.
  CHECK (
    kind = 'settle'
    OR (provider IS NULL AND model IS NULL AND outcome IS NULL
        AND input_tokens IS NULL AND output_tokens IS NULL)
  )
);

-- One reservation for a reservation id, and one closing entry for it.
CREATE UNIQUE INDEX model_ledger_reserved_once
  ON model_ledger_entries (organisation_id, reservation_id) WHERE kind = 'reserve';
CREATE UNIQUE INDEX model_ledger_closed_once
  ON model_ledger_entries (organisation_id, reservation_id) WHERE kind <> 'reserve';

-- "What an organisation has spent this month" and "what a task has spent" are what is asked before
-- every model call.
CREATE INDEX model_ledger_period_idx ON model_ledger_entries (organisation_id, period);
CREATE INDEX model_ledger_task_idx ON model_ledger_entries (organisation_id, task_id) WHERE task_id IS NOT NULL;

ALTER TABLE model_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON model_budgets
  FOR SELECT
  TO codemugs_app
  USING (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid);

ALTER TABLE model_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_ledger_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON model_ledger_entries
  TO codemugs_app
  USING (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid)
  WITH CHECK (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid);

-- Read only: an operator writes this table.
GRANT SELECT ON model_budgets TO codemugs_app;
-- Insert and read only. No UPDATE, DELETE or TRUNCATE.
GRANT SELECT, INSERT ON model_ledger_entries TO codemugs_app;
