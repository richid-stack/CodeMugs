-- 0002: API keys and the audit log. See ADR 0010.
--
-- API keys belong to one project. The key itself is never stored: only the SHA-256 of its secret
-- part. The composite foreign key to projects means a key can never point at a project of
-- another organisation.
--
-- The audit log is append-only: the application role can only read and insert, and triggers
-- stop updates, deletes and truncation even for roles that hold those privileges. A database
-- administrator can still disable triggers, so this protects against the application and against
-- mistakes, not against someone with administrator access to the database.

CREATE TABLE api_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
  project_id      uuid NOT NULL,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  secret_hash     bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES projects (organisation_id, id) ON DELETE RESTRICT
);

CREATE INDEX api_keys_project_idx ON api_keys (organisation_id, project_id);

-- Revocation is permanent: once set, revoked_at cannot be cleared or moved.
CREATE FUNCTION api_keys_revocation_is_permanent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'api key revocation cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER api_keys_revocation_is_permanent
  BEFORE UPDATE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION api_keys_revocation_is_permanent();

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_keys
  TO codemugs_app
  USING (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid)
  WITH CHECK (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid);

-- The application can create keys and revoke them. It cannot change a key's secret or project,
-- and cannot delete keys (a revoked key stays, so the audit trail still points at something).
GRANT SELECT, INSERT ON api_keys TO codemugs_app;
GRANT UPDATE (revoked_at) ON api_keys TO codemugs_app;

CREATE TABLE audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
  occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- A first cut. Operator and break-glass access is still an open question (open-questions.md,
  -- gap 3), so this is not final.
  actor_type      text NOT NULL CHECK (actor_type IN ('system', 'api_key', 'user', 'operator')),
  actor_id        uuid,
  action          text NOT NULL CHECK (
                    length(action) <= 100 AND action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'
                  ),
  target_type     text CHECK (target_type ~ '^[a-z][a-z_]{0,49}$'),
  target_id       uuid,
  request_id      text CHECK (length(request_id) <= 64),
  -- Small, flat context only. Never secrets or personal data (invariant 3).
  metadata        jsonb NOT NULL DEFAULT '{}' CHECK (
                    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 4096
                  ),
  CHECK ((actor_type = 'system') = (actor_id IS NULL))
);

CREATE INDEX audit_log_organisation_time_idx ON audit_log (organisation_id, occurred_at DESC);

CREATE FUNCTION audit_log_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'integrity_constraint_violation';
END
$$;

CREATE TRIGGER audit_log_no_update_or_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON audit_log
  FOR SELECT TO codemugs_app
  USING (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid);
CREATE POLICY tenant_append ON audit_log
  FOR INSERT TO codemugs_app
  WITH CHECK (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid);

GRANT SELECT, INSERT ON audit_log TO codemugs_app;
