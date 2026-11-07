# sandbox-manager

**Status:** Planned · Phase 5 Engineering

Isolated execution environments: CPU, memory, process and filesystem limits, network egress policy, temporary credentials, timeouts and cleanup. A hard prerequisite before any agent executes code.

This directory marks a module boundary from the [architecture overview](../../docs/architecture/overview.md). Nothing is implemented here yet. When work starts, add a `package.json` (the pnpm workspace picks it up automatically) and replace this file with the module's real interface.
