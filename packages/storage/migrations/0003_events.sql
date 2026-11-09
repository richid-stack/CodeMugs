-- 0003: events. See ADR 0011.
--
-- One row per event accepted from an SDK or gateway. Events are immutable: the application can
-- insert and read them, never update or delete them, so what was acknowledged to a client stays
-- what was acknowledged. Deleting events for retention or offboarding needs a deliberate,
-- audited path that does not exist yet (release gate 15); when it does, this grant changes and
-- the schema guard's append-only list changes with it.
--
-- The primary key is the idempotency key. A client generates eventId, so a retried batch hits
-- the same key and is acknowledged as a duplicate instead of being stored twice. It is scoped to
-- the project, so two projects can never collide, and it includes organisation_id like every
-- other key on a tenant table.
--
-- The table is not partitioned. PostgreSQL requires a partition key inside every unique
-- constraint, which would weaken the idempotency key (a retry arrives at a different time).
-- Volume decides when events move to an analytical store (ADR 0005, open question 15).
--
-- Vocabulary (which environments and event types exist) belongs to @codemugs/event-schemas, not
-- to the database. The checks below only keep values within sane bounds, so adding an
-- environment never needs a migration. They are never stricter than the schema, so anything the
-- ingestion code accepts can be stored.

CREATE TABLE events (
  organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
  project_id      uuid NOT NULL,
  event_id        uuid NOT NULL,
  -- Which key sent it, for tracing a misbehaving SDK. Keys are never deleted, only revoked.
  api_key_id      uuid NOT NULL,
  schema_version  smallint NOT NULL CHECK (schema_version > 0),
  type            text NOT NULL CHECK (length(type) BETWEEN 1 AND 128),
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  environment     text NOT NULL CHECK (length(environment) BETWEEN 1 AND 32),
  sdk_name        text NOT NULL CHECK (length(sdk_name) BETWEEN 1 AND 64),
  sdk_version     text NOT NULL CHECK (length(sdk_version) BETWEEN 1 AND 32),
  attributes      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(attributes) = 'object'),
  PRIMARY KEY (organisation_id, project_id, event_id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES projects (organisation_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organisation_id, api_key_id) REFERENCES api_keys (organisation_id, id) ON DELETE RESTRICT
);

-- Built now because adding an index later cannot be done without blocking writes: migrations run
-- in a transaction, which rules out CREATE INDEX CONCURRENTLY. Both are for readers that do not
-- exist yet (investigations by time window, retention by age) and are to be measured, not assumed.
CREATE INDEX events_project_time_idx ON events (organisation_id, project_id, occurred_at);
CREATE INDEX events_received_idx ON events (organisation_id, received_at);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON events
  TO codemugs_app
  USING (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid)
  WITH CHECK (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid);

-- Insert and read only. No UPDATE, DELETE or TRUNCATE.
GRANT SELECT, INSERT ON events TO codemugs_app;
