# unit

**Status:** Planned · Phase 1 Foundation

Unit tests currently sit next to the code they cover as `*.test.ts`. This directory is for cross-package unit suites if they are ever needed.

This directory marks a module boundary from the [architecture overview](../../docs/architecture/overview.md). Nothing is implemented here yet. When work starts, add a `package.json` (the pnpm workspace picks it up automatically) and replace this file with the module's real interface.
