# 0004. TypeScript first, Python where it provides a real advantage

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

The platform needs an API, gateways and workers, SDKs for JavaScript and Python, and eventually statistical and machine learning workloads. The options were TypeScript-first, Python-first, or polyglot from the start.

## Decision

TypeScript-first. The API, gateways, orchestration, shared libraries and the JavaScript SDK are TypeScript on Node.js. Python is used where it gives a real advantage: the Python SDK, and specialised intelligence or data processing where the TypeScript ecosystem is not adequate.

## Consequences

- Strict TypeScript, ESM, and a single toolchain for most of the codebase.
- Python components are separate packages that communicate with TypeScript services through explicit contracts (event schemas, HTTP, queues), not shared code.
- A Python workspace and its tooling are added when the first Python component is built, not before.
- TypeScript is currently held below 6.1 because typescript-eslint does not yet support later versions. The cap lives in `renovate.json`.

## Revisit when

Phase 4 (Intelligence) begins. That is when the real boundary between TypeScript and Python workloads becomes clear.
