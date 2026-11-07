# ingestion

**Status:** Planned · Phase 2 Understanding / 3 Observability

Ingestion gateways for SDK events and the OpenTelemetry endpoint. Authenticate the caller, derive tenant and project from the credential, validate against `@codemugs/event-schemas`, enforce rate and payload limits, acknowledge quickly and process asynchronously.

This directory marks a module boundary from the [architecture overview](../../docs/architecture/overview.md). Nothing is implemented here yet. When work starts, add a `package.json` (the pnpm workspace picks it up automatically) and replace this file with the module's real interface.
