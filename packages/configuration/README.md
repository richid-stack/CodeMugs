# @codemugs/configuration

Typed, validated environment configuration.

**Status:** Phase 1 · Foundation (started)

- `parseEnv(schema, env)` validates an environment object against a zod schema and throws `ConfigError` on failure.
- `loadApiConfig(env)` returns the API's configuration with safe defaults.

`ConfigError` messages list the offending variable names and the reason, and never the rejected values, so a mistyped secret cannot end up in a log. This is covered by a test.

Add new service configuration as a schema in this package so every process validates its environment the same way and fails fast at startup.
