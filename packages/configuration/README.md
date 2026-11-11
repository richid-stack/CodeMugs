# @codemugs/configuration

Typed, validated environment configuration.

**Status:** Phase 1 · Foundation (started)

- `parseEnv(schema, env)` validates an environment object against a zod schema and throws `ConfigError` on failure.
- `loadApiConfig(env)` returns the API's configuration with safe defaults. `DATABASE_URL` is optional outside production and required in production.
- `loadWorkerConfig(env)` returns the job worker's configuration. `DATABASE_URL` and `DISPATCHER_DATABASE_URL` are both required in every environment and must differ, and both come back wrapped in `Secret`. Concurrency, poll interval, lease and shutdown timeout have bounds and defaults ([`apps/worker`](../../apps/worker/README.md)).
- `loadMigrationConfig(env)` returns the migration command's configuration. `MIGRATION_DATABASE_URL` is required in every environment (and `DATABASE_URL` is not accepted in its place), and comes back wrapped in `Secret`. `MIGRATION_TIMEOUT_MS` has bounds and a default ([`apps/migrate`](../../apps/migrate/README.md)).
- `Secret` wraps a value (the database URL, later tokens) so it cannot be printed, logged or serialised by accident: string conversion, `JSON.stringify` and `util.inspect` all give `[redacted]`, and the value is only available through an explicit `reveal()`. It does not stop code that reveals a value and then prints it.

`ConfigError` messages list the offending variable names and the reason, and never the rejected values, so a mistyped secret cannot end up in a log. This is covered by a test.

Add new service configuration as a schema in this package so every process validates its environment the same way and fails fast at startup.
