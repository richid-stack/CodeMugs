# 0022. The demo application: dependency-free, correct on main, with its faults kept outside it

- **Status:** Accepted
- **Date:** 2026-11-14

## Context

The roadmap's step 6 is "a small TypeScript application with deliberately seeded faults, used as the test subject and as the first labelled incidents". Three things about it are not obvious, and each would be hard to change once steps 7 and 9 depend on it:

- Where the faults live. If the buggy code is on `main`, `pnpm verify` fails, or the tests that find the bugs have to be hidden from it. If the answers (what is wrong and how to fix it) sit next to the code, the engine reads them when it reads the repository.
- How it runs in the sandbox. The sandbox has no network ([ADR 0016](0016-sandbox-policy-and-driver-interface.md)), so an application that needs an install step cannot run there without a prepared image.
- Whether it counts as customer code. Invariant 8 says customer code never runs outside the sandbox.

## Decision

1. **The demo application is a package of its own, `tests/demo-shop`, and it is correct on `main`.** Its tests pass, and `pnpm verify` covers it like every other package. The workspace gains the glob `tests/*` for it.
2. **It has no dependencies and no build.** It is TypeScript that Node runs by removing the types (Node 22.18 and later, which `engines` says), and its tests use `node:test`. A bare copy of its directory runs with only a Node image, which is what an offline sandbox has. It uses only syntax that can be removed (`erasableSyntaxOnly`), so the compiler says when a change would break that. Its imports end in `.ts`, unlike the rest of the repository, because nothing compiles it.
3. **The faults are not in it.** They will be a catalogue of exact-text edits, kept in a second package, `tests/demo-incidents` (step 6b, not built yet), with the cause, the symptom in the telemetry, the test that shows it and the change that removes it for each. A faulty copy is made by applying one fault to a copy of the application, and only that copy is given to the engine. Each fault is to be proven: applying it makes a named test fail and the telemetry show its symptom, and the change that removes it makes the test pass.
4. **It says what it is doing in the platform's own event shape.** Events have a dot-separated lowercase type, an ISO time and attributes, as lines of JSON, so that step 9 can send what a running copy says to `POST /v1/events` and have something to detect in.
5. **It is first-party, and it is run in the sandbox anyway when the engine works on it.** It is code written here for testing, not code from a customer, so its own tests and the proofs of the faults may run on a developer's machine or in CI. The point of it is to exercise the real path, so the engine's work on a faulty copy (reading it, changing it, running its tests) goes through the sandbox exactly as a customer's would, and nothing here is an exception to invariant 8.

## Consequences

- **What exists now (step 6a).** The application, with 73 tests that pass, and a typecheck and lint that pass. Its tests were checked by breaking the code in 78 ways, one at a time: 72 were caught by the first tests, and tests were added for five of the six that were not. The sixth changes a regular expression whose job the next check does anyway, so the behaviour is the same, and it was left.
- **What does not exist yet.** The catalogue, the way of making a faulty copy, the proofs, and the telemetry of a faulty copy under traffic (step 6b). Until then nothing may be said about how many faults there are or how well they are detected.
- **The application is small on purpose.** It has routes, a service with money and stock, and a store behind an interface that is asynchronous the way a database is, because each of the faults to come needs one of those. It is not a model of a shop, and it says nothing about how the platform will do on a real customer's code. Evaluating that needs real incidents ([open question 14](../open-questions.md)).
- **A customer's repository usually has dependencies.** Running one in the sandbox needs a way to get them in with no network, which this application avoids and does not answer. It is a question for step 7 or 9, and is not decided here.
- **The directory is under `tests/`.** It is a test subject and evaluation data, and `tests/agent-evaluations` will hold what evaluates against it. Moving it later costs a directory rename and one line of workspace configuration.

## Rejected alternatives

- **Faults on `main`, with the failing tests marked as expected failures.** `pnpm verify` would stop meaning that everything is right, and a real bug would hide among the expected ones.
- **Faults switched on by a flag or an environment variable.** The engine's job is to find and change code, and a flag is not a bug in code. It also leaves the answer in the repository.
- **A separate repository for the application.** It needs the owner to create it, and the owner has no computer. Nothing here needs it.
- **Vitest, and normal dependencies.** The sandbox would need an image with an install, for no gain at this size.
- **Fault edits as unified diffs.** A patch that no longer applies after a harmless change gives an error that says little. Exact text, which must be found once, is simpler to check and says what it could not find.
