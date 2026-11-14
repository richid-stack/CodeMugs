# demo-shop

**Status:** Implemented · Step 6a of the [roadmap](../../docs/engineering/roadmap.md) · [ADR 0022](../../docs/architecture/decisions/0022-the-demo-application.md)

A small order-taking application that stands in for a customer's. The platform will read it, watch it, and change it, so that every step has something real to work on. It is first-party code written for that purpose. It is **not** customer code, and it has **no faults on `main`**: the faults are seeded later, from a catalogue that is kept outside it (see below).

## What it does

An in-memory shop with five products. It prices an order (discount codes, tax by country, all in whole cents), reserves stock, makes the order once even when the request is sent twice, and lists a customer's orders in pages.

| Route                       | What it does                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `GET /health`               | `{ "ok": true }`                                                                     |
| `GET /products`             | The catalogue                                                                        |
| `POST /orders`              | Makes an order. An `Idempotency-Key` header makes a repeat of it return the same one |
| `GET /customers/:id/orders` | Their orders, newest first. `page` and `pageSize` (default 10, at most 50)           |

A failure inside the shop tells the caller `{ "error": "internal_error" }` and nothing else. The details go to its own telemetry.

## What it says about itself

Events with a dot-separated lowercase `type`, an ISO 8601 `occurredAt` and some `attributes`, as one JSON object per line on standard output. They are the shape of the platform's [event envelope](../../packages/event-schemas/src/index.ts) without the parts that a gateway adds (the event id, the environment and the SDK).

| `type`               | When                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| `shop.started`       | The server is listening                                               |
| `inventory.stocked`  | At start, once for each product, with its starting quantity           |
| `inventory.reserved` | Units were taken for an order                                         |
| `order.created`      | An order was made, with its totals and its idempotency key            |
| `order.rejected`     | An order was refused, with the reason                                 |
| `http.request`       | Every request served, with the route, the status and how long it took |
| `error.captured`     | Something threw inside the shop, with the error's name and message    |

## Running it

```bash
pnpm --filter @codemugs/demo-shop test        # 73 tests, by Node's own test runner
pnpm --filter @codemugs/demo-shop typecheck
PORT=3000 node tests/demo-shop/src/main.ts    # needs Node 22.18 or later
```

## Why it is built this way

- **No dependencies.** It runs on Node and nothing else. The sandbox has no network ([ADR 0007](../../docs/architecture/decisions/0007-build-the-sandbox-early.md)), so a program that needs an install step cannot be run there without a prepared image, and this one needs only Node.
- **TypeScript without a build.** Node 22.18 and later run TypeScript by removing the types, so `src/` is what runs. That is why its imports end in `.ts` (the rest of the repository uses `.js`, because it is compiled) and why only syntax that can be removed is used (`erasableSyntaxOnly`: no enums, no parameter properties).
- **Its tests are its own.** They use `node:test`, not Vitest, so that the same command works in a bare copy of this directory.

## The faults

None are in this directory. A catalogue of labelled faults, each with the cause, the symptom in the telemetry, the test that shows it and the change that removes it, will live in `tests/demo-incidents` (step 6b, **not built yet**). It is kept apart so that the answers never travel with the code that the engine reads.
