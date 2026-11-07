# sandbox

**Status:** Planned · Phase 5 Engineering

Hardened sandbox runtime definitions. Docker first; gVisor, Kata Containers or Firecracker evaluated for stronger isolation.

This directory marks a module boundary from the [architecture overview](../../docs/architecture/overview.md). Nothing is implemented here yet. When work starts, add a `package.json` (the pnpm workspace picks it up automatically) and replace this file with the module's real interface.
