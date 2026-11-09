-- 0004: jobs. See ADR 0012.
--
-- A durable queue in PostgreSQL. A job is the unit of work for one subject (kind + subject_id):
-- running it again is a requeue of the same row, not a new row.
--
-- The queue holds POINTERS, NEVER DATA. There is deliberately no payload column. What a job
-- works on lives in tenant tables that the subject_id points at, behind row-level security.
-- That is what makes the second role below safe: it can see every tenant's jobs, and a job holds
-- nothing but its kind, its subject's id and its progress. The schema guard fails if a column is
-- ever added to this table without that being decided again.
--
-- Two roles use this table:
--   codemugs_app         The API and the workers' handlers. Sees only its own tenant's jobs, like
--                        every other table. Enqueues, completes (in the same transaction as the
--                        work), fails and requeues.
--   codemugs_dispatcher  Held only by worker processes, never by the API. Needs to find the next
--                        runnable job in ANY tenant, which row-level security otherwise forbids.
--                        It can read this table and move jobs from queued or running to running
--                        or dead.
--                        It has no privilege on any other table.
-- Roles are created by infrastructure, not here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'codemugs_dispatcher') THEN
    RAISE EXCEPTION 'role codemugs_dispatcher must exist before migrating';
  END IF;
END
$$;

CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
  kind            text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  -- The tenant row the job is about, for example a batch of events. Optional.
  subject_id      uuid,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
  -- When the job may next be claimed. For a running job it is when the lease runs out: after
  -- that, another worker may take the job, which is how a crashed worker's job is recovered.
  available_at    timestamptz NOT NULL DEFAULT now(),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
  -- Proves ownership of the current lease. Set only while running. Completing or failing a job
  -- needs the token, so a worker whose lease was taken over cannot finish the job.
  lease_token     uuid,
  -- A short stable code, never a message: messages can repeat customer data.
  last_error_code text CHECK (length(last_error_code) BETWEEN 1 AND 64),
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, kind, subject_id),
  CHECK (attempts <= max_attempts),
  CHECK ((status = 'running') = (lease_token IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'dead')) = (finished_at IS NOT NULL))
);

-- Everything a claim looks at: queued or running jobs, oldest availability first.
CREATE INDEX jobs_due_idx ON jobs (available_at, id) WHERE status IN ('queued', 'running');

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON jobs
  TO codemugs_app
  USING (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid)
  WITH CHECK (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid);

-- The only policies in the schema that do not depend on a tenant. They apply to the dispatcher
-- only, on this table only. The schema guard refuses a policy for this role anywhere else.
--
-- Two policies, not one, because PostgreSQL also checks an updated row against the read policy:
-- the dispatcher must be able to read the 'dead' row it has just written, or dead-lettering a job
-- would fail. It never reads 'succeeded' jobs, and it cannot change a dead one.
CREATE POLICY dispatcher_read ON jobs
  FOR SELECT
  TO codemugs_dispatcher
  USING (status IN ('queued', 'running', 'dead'));

-- It may take a waiting or running job (a running job whose lease ran out) and make it running or
-- dead. It cannot complete a job or put one back in the queue: only the owning tenant does that.
CREATE POLICY dispatcher_claim ON jobs
  FOR UPDATE
  TO codemugs_dispatcher
  USING (status IN ('queued', 'running'))
  WITH CHECK (status IN ('running', 'dead'));

-- The application can create and read jobs, and change only their progress. It cannot change what
-- a job is (kind, subject, tenant, limits) and cannot delete jobs.
GRANT SELECT, INSERT ON jobs TO codemugs_app;
GRANT UPDATE (status, available_at, attempts, lease_token, last_error_code, finished_at)
  ON jobs TO codemugs_app;

-- The dispatcher reads jobs and changes progress. It cannot create, delete or rewrite jobs.
GRANT SELECT ON jobs TO codemugs_dispatcher;
GRANT UPDATE (status, available_at, attempts, lease_token, last_error_code, finished_at)
  ON jobs TO codemugs_dispatcher;
