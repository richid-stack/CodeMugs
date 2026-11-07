# system-graph

**Status:** Planned · Phase 2 Understanding

The Application Intelligence Graph. Entities (services, endpoints, tables, deployments, incidents, commits) and relationships (calls, depends on, writes to, introduced by), stored relationally in PostgreSQL first.

This directory marks a module boundary from the [architecture overview](../../docs/architecture/overview.md). Nothing is implemented here yet. When work starts, add a `package.json` (the pnpm workspace picks it up automatically) and replace this file with the module's real interface.
