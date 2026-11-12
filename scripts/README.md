# scripts

Developer and operations helper scripts.

| Script                    | Run with               | Purpose                                                                                                                                                                                               |
| ------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke-api.mjs`           | `pnpm smoke`           | Starts the built API and checks health, readiness, the 404 shape, graceful shutdown on SIGTERM, and that invalid configuration fails without echoing values                                           |
| `check-workflow-pins.mjs` | `pnpm check:workflows` | Fails if a workflow uses an action that is not pinned to a full commit SHA, or a container image that is not pinned by digest ([ADR 0019](../docs/architecture/decisions/0019-pin-github-actions.md)) |

Run `pnpm build` first. `pnpm verify` and CI run the smoke test after the unit tests, because it covers behaviour that only exists in the compiled process.

`pnpm check:workflows` needs no build. It runs the checker on `.github/workflows` and then the checker's own tests (`scripts/*.test.mjs`, with `node --test`, no dependency). To check another directory: `node scripts/check-workflow-pins.mjs <directory>`.
