# 0023. The incident catalogue: faults as exact-text edits, proven by the shop's tests and by detectors over its telemetry

- **Status:** Accepted
- **Date:** 2026-11-14

## Context

[ADR 0022](0022-the-demo-application.md) decided that the demo shop is correct on `main` and that its faults are kept outside it, in `tests/demo-incidents`. This record says what a fault is, how a faulty copy is made, and what is proved about each one. The first user of the catalogue is step 9, where the engine is given a faulty copy and a symptom, and has to find the cause and make a change that a check which is not the engine's accepts (invariant 5).

Four questions had to be answered, and each is hard to change once step 9 depends on it:

- What a fault is made of, so that it can be applied, undone, and checked.
- How to know that a fault is really in the copy, and that it is the only thing wrong.
- How the symptom shows without the engine being told the cause. The engine gets telemetry and a customer's message, never the root cause.
- What keeps the copy from saying where it came from.

## Decision

1. **An incident is one JSON file in `tests/demo-incidents/incidents/`, named for its id, and a strict schema checks it.** Keys that the schema does not know are refused, at every level. It holds: the id, a title, a kind, a severity, a difficulty from 1 to 3 (the author's judgement, not a measurement), the root cause (for whoever grades a diagnosis, never given to the engine), the edits, the symptoms (the detector that finds it, what shows in the telemetry in words, and one customer message) and the witness. The loader says where a file is wrong and never what it holds, and refuses a file whose name is not its id.
2. **A fault is a list of exact-text edits to source files of the shop, and never to its tests.** Each edit is lines to find and lines to put in their place. The text must be in the file exactly once. An edit that cannot be made fails with a code (`not_found`, `ambiguous` or `unchanged`) and names the file and the edit, never the text. The paths are restricted by the schema to `src/**/*.ts` with no `.` or `..` in them. **The reference fix is the same edits undone, in the opposite order.** It is one fix that removes the fault, and not the only one.
3. **A faulty copy is a new directory that the harness writes.** It holds the shop's `src`, and a `package.json`, a `tsconfig.json` and a `README.md` that the harness writes. Then the edits are applied. The shop's own `package.json` and readme are not copied: they said that the shop has "no faults on `main`" and named this repository, which the engine must not read. The copy says nothing about its origin, and a test reads every file of a clean copy and of each faulty copy for the words fault, incident, seeded, planted, ground truth, ADR, CodeMugs, sandbox, witness, detector and root cause. The shop's own word for its products, "catalogue", is not on that list, because it is in the shop's source.
4. **The witness is the shop's own tests that fail with the fault in.** It is recorded as `file > test name`. The proof demands that the failing tests of the faulty copy are exactly the witness: not fewer (the fault would not be what it says) and not more (something else would be wrong).
5. **The symptom is found by a detector over the shop's telemetry, and there is one for each fault.** A detector is a pure function from events to findings. There are five: `crashes-on-request` (errors that were captured), `oversold-stock` (reservations, less what was given back, that exceed what was stocked), `pages-miss-orders` (a complete walk through a customer's pages that holds more or fewer orders than the total), `duplicate-orders` (two orders for one customer and one idempotency key) and `negative-total` (an order that costs less than nothing). Telemetry is untrusted data (invariant 2), so a detector reads only the attributes it knows as text or as finite numbers, groups with keys that cannot run together, and does an amount of work that is bounded by the number of events and not by the numbers in them.
6. **The traffic is a script, the same for the same seed, and it is sent over real HTTP to a running copy.** It sends 60 ordinary orders, six that are repeated, three pairs that are sent twice at once, a burst of six customers for the shop's last teapot, two orders for a spoon with a discount code (one for collection, one to be sent), and a regular customer with 25 orders whose pages are read with two page sizes. The shop's stock sits behind a store that takes 5 milliseconds to answer, which is the time in which concurrent requests see the same level.
7. **The copy is run by plain Node, in a process of its own, with no environment and a time limit.** A copy that crashes, hangs, or prints something that is not JSON gives a `HarnessError` that names the script and the exit code and carries the last lines that it said, without its stack frames. The scripts refuse a directory that is not an absolute path, because a relative one would be read against their own and would run something other than the copy.
8. **The proof is a test, `src/incidents.test.ts`, and it is what a claim about an incident stands on.** For the shop on main: every test passes and none is skipped, test names are unique within a file, and no detector finds anything for the seeds 1, 2 and 3. For each incident: the copy is not the shop; the failing tests equal the witness; its own detector fires, and no other, for the seeds 1, 2 and 3; a second run gives the same tests, findings and statuses; most tests still pass; applying the edits undone gives a tree with the same hash as a clean copy; and that copy passes every test and has no finding. `evaluateShop` is the function that gives a verdict on a copy (the tests that fail, and the findings), and it is what step 9 uses to judge a change that was not made by the harness.
9. **The shop gained what the harness needs, and nothing that is a fault.** Two events (`inventory.released`, when an order that failed gives its units back, and `orders.listed`, with the page, the page size, how many came back and the total), and a latency in the in-memory stock store, which is off unless it is asked for. All of it is correct on `main` and has its own tests.

## Consequences

- **What was run, locally, before this was merged.** `pnpm verify` passed (the result of the run in CI is in the pull request). The shop has 78 tests, all passing. The package has 182 tests in 8 files, all passing, 47 of them the proofs of decision 8. The five incidents behave as designed. Under the harness's traffic with seed 1 they gave:

  | Incident                   | Tests that fail | Detector finds                                           |
  | -------------------------- | --------------- | -------------------------------------------------------- |
  | `pickup-order-crash`       | 6               | the same TypeError 11 times; 11 requests answered 500    |
  | `oversell-race`            | 5               | 6 units held of the 1 that was stocked, no failed status |
  | `page-skips-newest-order`  | 6               | pages hold 24 orders of 25, for both page sizes          |
  | `idempotency-key-mismatch` | 3               | 9 pairs of orders for one customer and one key           |
  | `discount-exceeds-order`   | 2               | 4 orders with a negative total                           |

- **The race was found not to happen at first.** The first version of the traffic sent two concurrent requests for the last teapot to a store that answered at once, and the fault produced no finding: the two requests did not overlap. The store now takes 5 milliseconds to answer and six customers ask together. Run twelve at a time on a machine with two processors (so slower than one at a time), the detector of each fault fired in all twelve runs of that fault, with seeds 1 to 3 mixed, and the clean shop gave no finding for the seeds 1 to 5. That is the evidence, and it is not a proof that a slower host cannot miss the race. If it does, the proof test fails, and the burst and the latency are the numbers to raise.
- **The tests of the harness were checked by breaking its code.** Mutants were written by hand for each source file of the package (the edits, the detectors, the copy, the evaluation, the schema and the loader), and the tests were run for each. A mutant that survived got a test that kills it, or showed that the code was wrong or not needed: the page detector was rewritten as a result. Two mutants of the final code still survive, and neither changes any result: a page size of 0 is refused by one guard but would give no finding anyway, and a count that can only be equal to or smaller than another is compared with `===` and not `>=`. Three faults of the harness itself were found while the tests were written, and fixed: the copy carried the shop's `package.json` and its words, a page size of 0 in an event made the page detector loop for ever, and an empty directory argument made the scripts run this package's own files as if they were a copy. The mutation script is not committed.
- **Five incidents are not a benchmark.** They were written by the author of the shop, who knew where to look, and each is a change to one file. They show that the harness works. They say nothing about how well the platform will do on a real customer's code, which needs real incidents ([open question 14](../open-questions.md)), and no figure about detection or repair may be quoted from them.
- **The customer messages are the author's.** They are text for step 9 to treat as untrusted data (invariant 2). They were not collected from anyone.
- **The first witness tests are broad for some faults.** `pickup-order-crash` fails six tests, five of them in the server's tests, because the server's setup makes orders with no address. That is a property of the shop's tests, and is the case for any witness: it is what failed, not the smallest thing that could.
- **The harness is first-party code that runs outside the sandbox**, as ADR 0022 decided, with an empty environment and a time limit. That is for the author's own tests and not a security boundary. The engine's work on a faulty copy goes through the sandbox in step 9.
- **Release gate 8 stays not started.** Nothing here is about isolation.

## Rejected alternatives

- **Faults as unified diffs.** A patch that no longer applies after a harmless change says little. Exact text that must be found once says what it could not find, and it inverts by swapping two fields.
- **One shop with the faults behind switches.** The engine's job is to find and change code, and a switch is not a bug in code (ADR 0022).
- **A symptom that is only a failing test.** The engine is not told which tests fail in a real incident. The telemetry and the customer's message are what a real one has.
- **Reading the witness from the first run.** The witness is a claim about what the fault does. If it were whatever a run printed, the proof could not fail when the fault changed.
- **An LLM to write the symptoms or to judge them.** Nothing here needs one, and the judge in the proof has to be independent of the engine (invariant 5), so it is code.
- **A mutation-testing tool.** It would be a new dependency for a package whose logic is small enough to break by hand.

## Not decided, or not done

- **How the engine is scored against the catalogue.** That is step 9 and `tests/agent-evaluations`. What is here is the verdict function and the answers.
- **More incidents, and incidents that need more than one file, a configuration, or a dependency.** Five is enough to build the first slice on.
- **How a telemetry stream from a copy gets to `POST /v1/events`.** The traffic script reads the events from memory, and sending them through the API is step 9.
- **Log-based and trace-based symptoms.** The detectors read the shop's events and nothing else.
