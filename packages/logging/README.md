# @codemugs/logging

How a CodeMugs process writes its log, built so that the log cannot carry customer data (repository invariant 3). Used by [`@codemugs/worker`](../../apps/worker/README.md) and [`@codemugs/migrate`](../../apps/migrate/README.md). The API logs with pino through Fastify and does not use it yet.

**Status:** Phase 1 · Foundation (started). Decision: [ADR 0014](../../docs/architecture/decisions/0014-worker-process.md), decision 6.

## What is here

- `createLogger(level, write?, now?)`: one JSON object per line on standard output, with `level`, `time` and `msg`. A call takes a message and **plain values only** (`string`, `number`, `boolean`), so an error, a row or a request cannot be passed by accident. The level, time and message are written last, so a field can never replace them.
- `describeFatal(error)`: what may be written about an error that ends a process: its type, its SQLSTATE if it is a database error, and its stack frames, **without its message** (a database error can repeat the value it rejected). The message is removed by matching it, not by looking for the first frame, which a message could imitate. If the stack does not start with the message, no frames are written.
- `describeFailure(error)`: a short safe code for why an operation failed: `db_<SQLSTATE>`, a network code such as `ECONNREFUSED`, or `unknown`. Never the message.

## What it does not do

- It does not redact. It is the caller's job to pass only identifiers and short codes, and the types make the careless version harder, not impossible: a string can still hold anything.
- No levels below `debug` are written, no transports, no request context. The format (level names, ISO time) differs from the API's pino (numbers, epoch milliseconds) and is to be unified when a log platform is chosen.

## Tests

```bash
pnpm --filter @codemugs/logging test
```
