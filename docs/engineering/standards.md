# Engineering standards

These describe what is already enforced by tooling, followed by conventions we hold ourselves to. They are defaults and can be changed with a [decision record](../architecture/decisions/).

## Enforced by tooling

- **TypeScript strict mode**, plus `noUncheckedIndexedAccess`, `noImplicitOverride` and `verbatimModuleSyntax`.
- **ESM** throughout, on Node 22 or later.
- **Type-aware ESLint**, including rules against floating and misused promises.
- **Prettier** for formatting.
- **Vitest** for tests, colocated as `*.test.ts` next to the code.
- **Exact dependency versions** (`save-exact`) with a committed lockfile and `--frozen-lockfile` in CI. Renovate proposes updates.
- **`pnpm verify`** runs build, typecheck, lint, format check and tests. CI runs the same steps.

Workspace packages are consumed from their built `dist/`, so run `pnpm build` after changing a package that others depend on.

## Conventions

- **Tenant identity comes from the authenticated credential**, never from a request body, query string or event payload.
- **Validate at every boundary.** Inputs are parsed against a schema before use. Unknown fields are stripped, not trusted.
- **Errors never expose internals.** Server errors return a generic message and a request ID. Detail goes to logs.
- **Logs never contain secrets or personal data.** Configuration errors name variables, not values.
- **Handlers are idempotent.** Delivery is at-least-once, so processing the same event twice must be safe.
- **Test failure paths**, not only the happy path: timeouts, dependency failures, malformed and hostile input.
- **Fail fast at startup** on invalid configuration, and shut down gracefully on SIGTERM.
- **Readiness reflects dependencies; liveness does not.** A database outage should remove the instance from traffic, not restart it.
- **Anything that changes a security or data boundary gets a decision record.**

## Version constraints

TypeScript is held below 6.1 because typescript-eslint does not yet support later versions. The cap is in `renovate.json`.
