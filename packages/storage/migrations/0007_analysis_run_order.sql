-- 0007: runs are ordered by when they were stored, not by the clock. See ADR 0026.
--
-- "The latest run of a project" was the newest analysed_at, and then the highest id. analysed_at is
-- the start of the transaction that stored the run (now()), so two runs that one transaction
-- stores have the same value, and the id, which is random, decided which of them was the latest.
-- A sequence says which was stored last without a clock, and it cannot tie.
--
-- The sequence is global: it counts the runs of every organisation, so the gaps in one
-- organisation's numbers are the activity of others. It is for ordering inside the database only
-- and is never returned: the reads of @codemugs/system-graph do not select it.
--
-- Nothing outside tests has stored a run yet. A run that was stored before this migration gets a
-- number in no particular order, so a database that holds runs that matter would have to number
-- them by analysed_at first.
--
-- The application role can insert into an identity column without any privilege on its sequence.

ALTER TABLE analysis_runs ADD COLUMN stored_seq bigint GENERATED ALWAYS AS IDENTITY;

CREATE INDEX analysis_runs_latest_idx ON analysis_runs (organisation_id, project_id, stored_seq DESC);

-- Nothing asks for the order of analysed_at any more.
DROP INDEX analysis_runs_project_idx;
