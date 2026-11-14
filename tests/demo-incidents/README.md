# demo-incidents

**Status:** Implemented · Step 6b of the [roadmap](../../docs/engineering/roadmap.md) · [ADR 0023](../../docs/architecture/decisions/0023-the-incident-catalogue.md)

Labelled faults for the [demo shop](../demo-shop/README.md), and the proof that each one is what it says it is. **The answers are here and never in the shop**: this package holds the cause, the fix and the tests that show each fault, and a copy of the shop that is given to the engine holds none of it.

This is not a benchmark. There are five incidents, written by the author of the shop. They show that the harness works, and say nothing about how the platform will do on a real customer's code.

## The incidents

| Incident                                                              | Kind        | Severity | Difficulty | Found by             |
| --------------------------------------------------------------------- | ----------- | -------- | ---------- | -------------------- |
| [`pickup-order-crash`](incidents/pickup-order-crash.json)             | null        | high     | 1          | `crashes-on-request` |
| [`discount-exceeds-order`](incidents/discount-exceeds-order.json)     | arithmetic  | medium   | 1          | `negative-total`     |
| [`page-skips-newest-order`](incidents/page-skips-newest-order.json)   | boundary    | medium   | 1          | `pages-miss-orders`  |
| [`idempotency-key-mismatch`](incidents/idempotency-key-mismatch.json) | idempotency | high     | 2          | `duplicate-orders`   |
| [`oversell-race`](incidents/oversell-race.json)                       | concurrency | high     | 3          | `oversold-stock`     |

Difficulty is the author's judgement: 1 is a bug that a reader finds from the symptom alone, 3 needs a theory about timing or state.

## What is in the package

| Path                     | What it is                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `incidents/*.json`       | One file for each incident, named for its id and checked by `src/schema.ts`                                 |
| `src/edits.ts`           | Applies exact-text edits to a directory, undoes them, and hashes a tree                                     |
| `src/materialise.ts`     | Makes a standalone copy of the shop, with or without a fault                                                |
| `src/detectors.ts`       | Five pure functions from the shop's telemetry events to findings                                            |
| `src/evaluate.ts`        | Runs a copy's tests and a day of traffic in processes of their own, and says what failed and what was found |
| `traffic/run-tests.ts`   | Runs a copy's tests with Node's test runner and prints how each went                                        |
| `traffic/run-traffic.ts` | Starts a copy and sends it a day's traffic over HTTP, the same for the same seed                            |
| `src/incidents.test.ts`  | The proof for the shop on main and for each incident                                                        |

## Use

```ts
import { loadIncidents } from "./src/catalogue.js";
import { materialiseIncident } from "./src/materialise.js";
import { evaluateShop } from "./src/evaluate.js";

const [incident] = await loadIncidents();
await materialiseIncident("/tmp/copy", incident); // the shop with the fault in
const { failing, findings } = await evaluateShop("/tmp/copy", 1); // seed 1
```

`evaluateShop` is the verdict on a copy: which of its tests fail, and what the detectors find in its telemetry. It does not know who made the change in a copy, which is the point.

```bash
pnpm --filter @codemugs/demo-incidents test        # about 30 seconds: the proofs run the shop many times
pnpm --filter @codemugs/demo-incidents typecheck
```

## What the proof says

For the shop on `main`: every test passes and none is skipped, and no detector finds anything for the seeds 1, 2 and 3. For each incident: the failing tests are exactly the ones recorded, its own detector fires and no other for the seeds 1, 2 and 3, a second run gives the same result, undoing the edits gives the same tree as a clean copy, and that copy passes everything.

## Limits

- The copy is run by plain Node with no environment and a time limit, outside the sandbox. It is the author's own code and the author's own tests; it is not a security boundary. The engine's work on a faulty copy goes through the sandbox (step 9).
- `oversell-race` depends on timing: the shop's stock store takes 5 milliseconds to answer, and six customers ask for the last teapot together. It fired in every run when twelve ran at once on a machine with two processors. A slower host could miss it, and then the proof fails.
- The customer messages in the files are written by the author and are untrusted text, as every message is.
