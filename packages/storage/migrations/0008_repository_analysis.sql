-- 0008: which repository a project is, and the requests to analyse it. See ADR 0031.
--
-- Three tables.
--
-- github_installations says which GitHub App installations belong to which organisation. It is
-- the only thing that lets an organisation point at a GitHub account: the app's installation
-- token reaches whatever the installation can see, so if a customer could name any installation
-- by its number (they are small integers) the platform would read another customer's private
-- repositories for them. The application role can therefore only READ this table. A row is made
-- by an operator, with the migration login, once the installation is known to be the
-- organisation's. The installation number is unique across organisations, so that an installation
-- cannot be bound to two of them; that is the one constraint in this schema that spans tenants,
-- and it is safe because no tenant can write the table or probe it.
--
-- repository_connections says that a project is a repository: the installation, the owner and the
-- name. A project has one. A connection is not changed once made; changing which repository a
-- project is needs a deliberate path, with an audit entry, that does not exist yet.
--
-- analysis_requests is a request to analyse a connection's repository at a ref. Its id is the
-- subject of the job that does it and the id of the run that it stores, so the request, the job
-- and the run are one thing. It is never changed: whether it is queued, running, done or failed is
-- read from the job and from the run.
--
-- The application can insert and read the last two, never update or delete. Deleting them for
-- retention or offboarding needs the path that release gate 15 asks for.

CREATE TABLE github_installations (
  organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
  installation_id bigint NOT NULL CHECK (installation_id > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, installation_id),
  UNIQUE (installation_id)
);

CREATE TABLE repository_connections (
  organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
  id              uuid NOT NULL,
  project_id      uuid NOT NULL,
  provider        text NOT NULL CHECK (provider = 'github'),
  installation_id bigint NOT NULL,
  -- As GitHub allows them, and no more: the owner is a user or organisation login and the name a
  -- repository name. Neither can hold a slash, a space or a control character, so neither can
  -- change the path of a request that is made from it.
  owner           text NOT NULL CHECK (owner ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  name            text NOT NULL CHECK (name ~ '^[A-Za-z0-9._-]{1,100}$' AND name NOT IN ('.', '..')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, id),
  -- One repository for each project, for now. Several would need a run to say which one it is of.
  UNIQUE (organisation_id, project_id),
  -- So that a request can name a connection and its project together, and have the database check
  -- that the connection is that project's.
  UNIQUE (organisation_id, project_id, id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES projects (organisation_id, id) ON DELETE RESTRICT,
  -- The installation must be one of this organisation's: the key carries both.
  FOREIGN KEY (organisation_id, installation_id)
    REFERENCES github_installations (organisation_id, installation_id) ON DELETE RESTRICT
);

CREATE TABLE analysis_requests (
  organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
  -- Chosen by the platform. It is also the job's subject and the run's id.
  id              uuid NOT NULL,
  project_id      uuid NOT NULL,
  connection_id   uuid NOT NULL,
  -- A branch, a tag or a commit, as the person gave it. The worker looks up the commit it names
  -- and analyses that, so the run says exactly what was analysed.
  ref             text NOT NULL CHECK (length(ref) BETWEEN 1 AND 255 AND ref !~ '[[:cntrl:] ]'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES projects (organisation_id, id) ON DELETE RESTRICT,
  -- The connection is the project's own. Two separate keys would let a request pair one project with
  -- another project's repository, and the worker would store that repository's graph as this
  -- project's.
  FOREIGN KEY (organisation_id, project_id, connection_id)
    REFERENCES repository_connections (organisation_id, project_id, id) ON DELETE RESTRICT
);

-- "The requests of a project, newest first" is the question that is asked.
CREATE INDEX analysis_requests_project_idx ON analysis_requests (organisation_id, project_id, created_at DESC, id);

ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON github_installations
  FOR SELECT
  TO codemugs_app
  USING (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid);

ALTER TABLE repository_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE repository_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON repository_connections
  TO codemugs_app
  USING (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid)
  WITH CHECK (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid);

ALTER TABLE analysis_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON analysis_requests
  TO codemugs_app
  USING (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid)
  WITH CHECK (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid);

-- Read only: an operator writes this table.
GRANT SELECT ON github_installations TO codemugs_app;
-- Insert and read only. No UPDATE, DELETE or TRUNCATE.
GRANT SELECT, INSERT ON repository_connections TO codemugs_app;
GRANT SELECT, INSERT ON analysis_requests TO codemugs_app;
