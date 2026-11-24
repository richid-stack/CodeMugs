# 0039. The model gateway

- **Status:** Accepted for the first part (the core). Failover and budgets, and a real provider's adapter, are planned and not decided here; see "Planned".
- **Date:** 2026-11-23

## Context

Step 8 of the [roadmap](../../engineering/roadmap.md) is a gateway in front of language models. Everything the platform asks a model will go through it, and what is asked is built from a customer's repository, logs and messages, which are untrusted ([threat model](../../security/threat-model.md), rows 3, 8, 11 and 12). The gateway is where four of the repository's invariants are kept for models: untrusted data is never instructions (2), no secrets in prompts (3), failures expose nothing (6), and the policy is the platform's and not an agent's (4). It is also where cost is seen, which release gate 17 needs, and where a provider's outage is handled, which gate 16 needs.

## Decisions

1. **A package of its own, `packages/model-gateway`, with one interface, `call(context, request)`.** A request is a task, the instructions, the data, a schema for the answer and a limit for its length. The answer is a value that has been checked against the schema. Nothing outside the package names a provider.
2. **Instructions and data are different things in the request itself.** Instructions are written by the platform and go in the system message. Data is a list of labelled, classified pieces that go in the user message, each between lines that carry a boundary made for the request and found in none of the content, so that content cannot close its own block. The system message says that the blocks are untrusted material. This does not make a model immune to what a repository says; it keeps the structure honest, and the output is treated as data too.
3. **What may be sent is decided by a policy that the gateway is given, per organisation and per class of data, and the default sends nothing.** The classes are those of the [data classification](../../security/data-classification.md) draft. The organisation is the call's, from the caller's authority, never from the request (invariant 1). A policy that cannot be read fails closed. Which classes may leave the platform by default is **not decided here**: it is the owner's decision recorded as open in the classification and in [open question 6](../open-questions.md), and until then the only policies are the one that denies and the one that a test or a deployment gives.
4. **Secret-like strings are removed from data before it is sent, and the count is returned.** Private keys, passwords in URLs, cloud keys, tokens and the values of names that say they are secret. It is a second line behind the rule that none is put in a request, and it makes no promise about a secret that does not look like one. Instructions that hold one are refused, because the platform wrote them. Every pattern is bounded and the key scan is a single pass, because the text is a customer's and the time must grow with its length and not its square; it is tested with text made to be slow.
5. **The answer is checked and is data until it has been.** It must have stopped by itself, be JSON (one code fence is allowed, as models add one) and fit the schema the caller gave. There is no automatic repair and no retry on an invalid answer: a retry costs money and the caller decides. A provider's schema support is a help (`native` or `prompted`), not something relied on.
6. **A failure is a code.** `ModelError` has a short code, whether it is the provider's fault and another try could do better, and a fixed sentence. A provider's own message can echo the prompt, so adapters throw `ProviderFailure` with a kind and nothing else, and the gateway never reads a message. The log has the task, the organisation's id, the provider, the model, the tokens, the cost, the redaction count and the code, and nothing that was said.
7. **The gateway gives up even on an adapter that does not.** Each call has a time limit and the caller's signal, and the wait is cut off when either fires whether or not the adapter looks at the signal. A late failure of the abandoned call is swallowed.
8. **Cost is in whole millionths of a US dollar, from the provider's price, rounded up for each part, with BigInt for the product.** Prices are the adapter's configuration, in integers, and the package holds none of any real provider (they change, and a constant here would be a claim about a vendor). The input size is guessed before a call (three characters to a token, which errs towards too big) to choose a provider; what is accounted is the count the provider gives, and a provider that gives none that is a whole number is a fault.
9. **A mock provider ships with the package**: scripted answers, failures of each kind, hangs and crashes, and a record of what it was asked. It is how everything that uses the gateway is tested, and how the failure handling will be.

## Planned (not built)

- **Failover and a circuit breaker** across several providers for the failures that are the provider's, and limits on the retry, with failures injected (release gate 16).
- **Budgets**: a per-task and per-organisation limit that is checked before a call against its worst-case cost and settled after, in a ledger that survives a restart, so that work stops when the money does (gate 17, [open question 10](../open-questions.md)). Usage kept per organisation for metering.
- **An adapter for a real provider**, which needs the owner's choice of provider, an API key and a monthly spend cap, and the provider's data-handling terms reviewed ([open question 6](../open-questions.md)).

## Consequences

- Everything that will ask a model has one place that enforces the policy, the redaction and the answer's shape, and a mock to test against. Nothing calls it yet.
- Tested with no database or network: each rule above, the failure paths of the request, the policy, the provider, the time limit and the caller, the answer, the cost and the setup, and that nothing of the data or the answer is in an error or a log. 28 faults were planted in the gateway one at a time and each is caught by a test (one needed a test made stronger).
- **Not shown:** a real provider; failover; a budget; stored usage; that the redaction finds every secret (it cannot); that a model follows the structure of the prompt; how long a real call takes. **Release gates 16 and 17 are not started**, and no claim is made about either.
- The classification's defaults, and so which classes any real deployment may send, remain the owner's decision.
