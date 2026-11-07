# sandbox

**Status:** Planned · Phase 2 Understanding (first driver), Phase 5 (isolation proof)

Hardened sandbox runtime definitions. A hardened container first, with network disabled by default. gVisor, Kata Containers or Firecracker are evaluated in Phase 2 for the hosted multi-tenant tier. A hardened container alone is not treated as sufficient for hostile third-party code. See [ADR 0007](../../docs/architecture/decisions/0007-build-the-sandbox-early.md).

This directory marks a module boundary from the [architecture overview](../../docs/architecture/overview.md). Nothing is implemented here yet. When work starts, add a `package.json` (the pnpm workspace picks it up automatically) and replace this file with the module's real interface.
