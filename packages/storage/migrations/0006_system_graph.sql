-- 0006: the system graph, first as what a repository analysis found. See ADR 0026.
--
-- One analysis of one project's repository is a run, and a run owns the nodes and edges that were
-- made from it (files, packages, routes, imports). Runs are immutable snapshots: nothing is ever
-- changed in a run, a newer analysis is a new run, and "the graph now" is the latest run of a
-- project. That keeps a retry harmless (the run's id is the idempotency key) and lets the platform
-- compare what the code was then with what it is now.
--
-- A run is written in one transaction with all its nodes and edges, so a run that can be read is a
-- run that is whole. Its counts are kept on the row so that a reader can check that.
--
-- Everything here comes from a customer's repository, so it is data and never instructions
-- (invariant 2). The checks only keep values within sane bounds. The vocabulary (which kinds of
-- node and edge exist) belongs to @codemugs/system-graph, not to the database, so adding a kind
-- never needs a migration. The bounds are never stricter than what @codemugs/application-intelligence
-- accepts, so anything that passed its schema can be stored.
--
-- The application can insert and read these tables, never update or delete. Deleting runs for
-- retention or offboarding needs a deliberate, audited path that does not exist yet (release
-- gate 15); when it does, these grants change and the schema guard's list changes with them.

CREATE TABLE analysis_runs (
  organisation_id uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
  -- Chosen by the caller, so that the same analysis stored twice is one run.
  id              uuid NOT NULL,
  project_id      uuid NOT NULL,
  -- The commit that was analysed, when it is known. A git object id, in SHA-1 or SHA-256 form.
  revision        text CHECK (revision ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  -- The version of the analyser's schema that the facts were in.
  facts_version   smallint NOT NULL CHECK (facts_version > 0),
  -- What the analyser had to cut short (a limit it hit). Empty means the graph is whole.
  truncated       text[] NOT NULL DEFAULT '{}' CHECK (cardinality(truncated) <= 16),
  -- Counts and limits of the analysis, never content.
  summary         jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  node_count      integer NOT NULL CHECK (node_count >= 0),
  edge_count      integer NOT NULL CHECK (edge_count >= 0),
  -- SHA-256 of the nodes and edges, so that storing the same id again with other facts is found
  -- and refused instead of being taken for a retry.
  digest          text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  analysed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, id),
  FOREIGN KEY (organisation_id, project_id) REFERENCES projects (organisation_id, id) ON DELETE RESTRICT
);

-- "The latest run of a project" is the question that is asked most.
CREATE INDEX analysis_runs_project_idx ON analysis_runs (organisation_id, project_id, analysed_at DESC, id);

CREATE TABLE graph_nodes (
  organisation_id uuid NOT NULL,
  run_id          uuid NOT NULL,
  -- A number within the run, given in the order of (kind, key), so the same facts give the same ids.
  id              integer NOT NULL CHECK (id >= 0),
  kind            text NOT NULL CHECK (kind ~ '^[a-z_]{1,32}$'),
  -- A path, a package name, "GET /orders", an environment variable's name.
  key             text NOT NULL CHECK (length(key) BETWEEN 1 AND 1024),
  attributes      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(attributes) = 'object'),
  PRIMARY KEY (organisation_id, run_id, id),
  -- The order of these columns matters for speed. Every edge is checked against this table twice,
  -- by (organisation_id, run_id, id), which is the primary key. If this index started with
  -- (organisation_id, run_id) too, then a table that has no statistics yet (a new database, the
  -- first minutes of a deployment) cannot tell the two apart, may use this one and filter on id,
  -- and then walks every node of the run for every edge. A run near the analysis limits (20,000
  -- nodes, 100,000 edges) then takes minutes and hits the statement timeout. Leading with kind
  -- leaves the primary key as the only index for that lookup. Looking a node up by kind and key
  -- within a run still matches all four columns.
  UNIQUE (organisation_id, kind, key, run_id),
  FOREIGN KEY (organisation_id, run_id) REFERENCES analysis_runs (organisation_id, id) ON DELETE RESTRICT
);

CREATE TABLE graph_edges (
  organisation_id uuid NOT NULL,
  run_id          uuid NOT NULL,
  from_id         integer NOT NULL,
  to_id           integer NOT NULL,
  kind            text NOT NULL CHECK (kind ~ '^[a-z_]{1,32}$'),
  attributes      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(attributes) = 'object'),
  -- One edge of a kind between two nodes. What differs between several occurrences (the lines of
  -- an import, say) is summarised in its attributes.
  PRIMARY KEY (organisation_id, run_id, from_id, to_id, kind),
  -- An edge joins two nodes of its own run, in its own organisation: the key carries both.
  FOREIGN KEY (organisation_id, run_id, from_id) REFERENCES graph_nodes (organisation_id, run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organisation_id, run_id, to_id) REFERENCES graph_nodes (organisation_id, run_id, id) ON DELETE RESTRICT
);

-- "What points at this node" (who imports a file) is the question that the primary key cannot
-- answer. Built now because an index cannot be added later without blocking writes (migrations run
-- in a transaction, which rules out CREATE INDEX CONCURRENTLY).
CREATE INDEX graph_edges_to_idx ON graph_edges (organisation_id, run_id, to_id, kind);

ALTER TABLE analysis_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON analysis_runs
  TO codemugs_app
  USING (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid)
  WITH CHECK (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid);

ALTER TABLE graph_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_nodes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON graph_nodes
  TO codemugs_app
  USING (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid)
  WITH CHECK (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid);

ALTER TABLE graph_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_edges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON graph_edges
  TO codemugs_app
  USING (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid)
  WITH CHECK (organisation_id = nullif(current_setting('app.organisation_id', true), '')::uuid);

-- Insert and read only. No UPDATE, DELETE or TRUNCATE.
GRANT SELECT, INSERT ON analysis_runs TO codemugs_app;
GRANT SELECT, INSERT ON graph_nodes TO codemugs_app;
GRANT SELECT, INSERT ON graph_edges TO codemugs_app;
