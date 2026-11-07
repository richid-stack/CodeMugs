# scripts

Developer and operations helper scripts.

| Script          | Run with     | Purpose                                                                                                                                                     |
| --------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke-api.mjs` | `pnpm smoke` | Starts the built API and checks health, readiness, the 404 shape, graceful shutdown on SIGTERM, and that invalid configuration fails without echoing values |

Run `pnpm build` first. `pnpm verify` and CI run the smoke test after the unit tests, because it covers behaviour that only exists in the compiled process.
