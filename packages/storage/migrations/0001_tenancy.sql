-- 0001: tenancy. The tenant root (organisations) and the first tenant-owned table (projects).
--
-- Every tenant-owned table has organisation_id NOT NULL, forced row-level security, and a policy
-- comparing it with the transaction-local setting app.organisation_id (see ADR 0006 and
-- packages/storage/src/tenant.ts). With the setting missing, no rows are visible: it fails closed.
--
-- Roles are created by infrastructure, not here. The application role must already exist. It must
-- not be a superuser, must not have BYPASSRLS, and must not own these tables.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'codemugs_app') THEN
    RAISE EXCEPTION 'role codemugs_app must exist before migrating';
  END IF;
END
$$;

CREATE TABLE organisations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, name),
  -- Lets child tables reference (organisation_id, id) so a row can never point at another
  -- tenant's project.
  UNIQUE (organisation_id, id)
);

ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organisations
  TO codemugs_app
  USING (id = nullif(current_setting('app.organisation_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.organisation_id', true), '')::uuid);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON projects
  TO codemugs_app
  USING (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid)
  WITH CHECK (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid);

-- Least privilege. No TRUNCATE (it ignores row-level security), no REFERENCES, no TRIGGER.
-- Organisations cannot be deleted by the application yet: deletion and retention come later.
GRANT SELECT, INSERT, UPDATE ON organisations TO codemugs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO codemugs_app;
