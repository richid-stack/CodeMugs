# connector-worker

**Status:** Planned · Phase 2 Understanding

Runs connector synchronisation: discover, collect, subscribe, incremental sync with checkpoints, credential rotation and connector health monitoring.

This directory marks a module boundary from the [architecture overview](../../docs/architecture/overview.md). Nothing is implemented here yet. When work starts, add a `package.json` (the pnpm workspace picks it up automatically) and replace this file with the module's real interface.
