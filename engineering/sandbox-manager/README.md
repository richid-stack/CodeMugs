# sandbox-manager

**Status:** Planned · Phase 1 Foundation (policy model and driver interface), Phase 2 (first driver), Phase 5 (isolation proof)

Isolated execution environments: CPU, memory, process and filesystem limits, network egress policy, temporary credentials, timeouts and cleanup. Customer code, and anything built from it, never runs outside this module, including repository analysis. See [ADR 0007](../../docs/architecture/decisions/0007-build-the-sandbox-early.md).

This directory marks a module boundary from the [architecture overview](../../docs/architecture/overview.md). Nothing is implemented here yet. When work starts, add a `package.json` (the pnpm workspace picks it up automatically) and replace this file with the module's real interface.
