# @codemugs/model-gateway

Provider-independent access to language models: one interface in front of any provider, with what may be sent decided by the organisation's policy, instructions kept apart from untrusted data, secret-like strings removed, the answer checked against a schema, and what a call cost worked out. The product is never hard-wired to one provider.

**Status:** Phase 1 · Foundation, step 8, first five parts ([ADR 0039](../../docs/architecture/decisions/0039-the-model-gateway.md), [ADR 0040](../../docs/architecture/decisions/0040-failover-and-a-circuit-breaker.md), [ADR 0041](../../docs/architecture/decisions/0041-budgets-in-the-model-gateway.md), [ADR 0042](../../docs/architecture/decisions/0042-a-budget-ledger-in-postgresql.md), [ADR 0043](../../docs/architecture/decisions/0043-an-adapter-for-the-anthropic-messages-api.md)). The core, failover across providers, a circuit breaker for each, budgets, and a mock provider exist and are tested, with failures injected through the mock. An adapter for a real provider is [`@codemugs/model-provider-anthropic`](../model-provider-anthropic/README.md), **not yet run against the real API** (there is no key); nothing calls the gateway, and **nothing sets a spending limit** in a deployment. The ledger in this package is **in memory**; the one that survives a restart and is shared between processes, with usage kept for each organisation, is [`@codemugs/model-budget`](../model-budget/README.md). Release gates 16 and 17 are **in progress, not closed**: nothing has met a real provider's failures, and nothing here caps spending in a deployment.

## What it does

```ts
import {
  createMockProvider,
  createModelGateway,
  permitClasses,
  unlimitedBudget,
} from "@codemugs/model-gateway";
import { z } from "zod";

const gateway = createModelGateway({
  providers: [createMockProvider({ steps: [{ value: { summary: "…", confidence: 0.8 } }] })],
  policy: permitClasses(["repository_facts"]), // what the organisation lets go; the default sends nothing
  budget: unlimitedBudget(), // what may be spent: required; a deployment gives a ledger with limits
});

const result = await gateway.call(
  { organisationId, taskId, signal }, // the organisation comes from the caller's authority, never from a request body; the task is optional
  {
    task: "diagnose",
    instructions: "Say what is wrong.", // written by the platform; nothing from a customer goes here
    data: [{ label: "routes", dataClass: "repository_facts", content: facts }], // untrusted
    output: z.object({ summary: z.string(), confidence: z.number() }),
    maxOutputTokens: 500,
  },
);
// result.value (checked), result.provider, result.inputTokens, result.outputTokens (of the attempt that answered),
// result.costMicros (of all the attempts, as the providers said), result.chargedMicros (taken from the budget),
// result.attempts, result.redactions
```

For each call, in this order:

1. **The request is checked**: names, labels, classes, sizes and the organisation's id (`invalid_request`), and the schema must be an object.
2. **The policy is asked** which classes of data may go to a provider for this organisation, and a class that it does not name does not go (`not_permitted`). A policy that cannot be read sends nothing (`policy_unavailable`). `denyAll` is the default; `permitClasses` is for tests and for a deployment that has decided.
3. **Secret-like strings are removed** from the data (private keys, passwords in URLs, cloud keys, tokens, values of names that say they are secret) and counted. It is a second line: the rule is that none is put in a request. Instructions that hold one are refused.
4. **Instructions and data are kept apart**: the instructions are the system message, and each piece of data is a block between lines with a boundary made for the request and found in none of the content, so content cannot close its block (invariant 2). Labels are checked, so they cannot either.
5. **The providers that may have the data, and have room** for the request and the answer, are the candidates. A provider declares the classes of data it may be sent (`capabilities.dataClasses`, from its terms: a free tier that may read what it is sent lists little or nothing); one that may not have a class of the request is **not a candidate, not even for a failover**, and it never widens the policy (`no_permitted_provider` if none may, `no_capable_provider` if none has room; [ADR 0044](../../docs/architecture/decisions/0044-a-providers-terms-for-data.md)). They are tried in the order given, up to `maxAttempts` (three unless set), and **another is tried only for a failure that is the provider's own**: it could not be reached, it limited the requests or it was too slow. An answer that was given and is no good, or a rejected request, is not failed over (see 7). Each attempt gets the time that the gateway allows (`timeoutMs`, for each attempt) and is given up on when the time is up (`timeout`) or the caller leaves (`aborted`), **even if the adapter ignores the signal**. The wait for the policy is given up too, and nothing is sent for a caller who has left.
6. **What the call used is worked out first**, because a call is billed whether or not its answer can be used. Usage that is not a whole count is a fault of the adapter (`provider_unavailable`) and cannot be accounted.
7. **The answer is data until checked**: it must have stopped by itself (`output_truncated`, `refused`), not be more output than was allowed (an adapter that reports so is not trusted: `provider_unavailable`), be JSON (one code fence is allowed) and fit the schema (`output_invalid`).
   The **cost** is in whole millionths of a US dollar from the provider's price, rounded up, with no float.

A failure is a `ModelError` with a short code, whether another try could do better (`retryable`) and a fixed sentence. It carries `attempts`: for each attempt the provider, the model, the outcome code and, when the provider answered (even with an answer that could not be used), the usage (tokens and cost, as numbers and names), so that the spend is not lost with the failure; `error.costMicros` is the sum. An attempt that got no answer (the provider failed, the call was given up on) has no usage, because it is not known, and a call refused before any provider was asked has no attempts. When every attempt fails the code is that of the last. **Nothing of a prompt, an answer, a provider's message or a policy's error is in it or in the log.** The log has the task and organisation (only when they are well formed; otherwise `invalid`, because a rejected request's values are not to be trusted into a log), provider, model, tokens, cost, redaction count and the outcome code.

## Failover and the circuit breaker

```ts
createModelGateway({
  providers: [primary, secondary], // in order of preference
  policy,
  timeoutMs: 30_000, // for each attempt
  maxAttempts: 3, // in one call (1..10)
  breaker: { failureThreshold: 5, cooldownMs: 30_000 }, // failures in a row (1..100); cooldown (1 ms..1 h)
});
gateway.providers(); // [{ name, model, state: "closed" | "open" | "half_open", consecutiveFailures }]
```

- A call goes to the first provider that is in use. For `provider_unavailable`, `rate_limited` or `timeout` it goes on to the next, never to the same provider twice. A refusal, a cut-short or invalid answer, or a rejection ends the call: the answer was paid for, or every provider would say the same, and it is the caller's to decide. A provider that reports more output than it was allowed, or usage that is not a count, has broken its contract: that is `provider_unavailable`, it is failed over and counted against the provider, and what it reported is still in the cost.
- After `failureThreshold` failures **in a row** that are the provider's, its breaker **opens** and the provider is not asked for `cooldownMs`. Then **one** call is let through (half open); if it works the breaker closes, and if not it opens again for a whole cooldown. Other calls meanwhile go to the other providers.
- An answer that is no good counts as the provider having been reached. A caller who leaves counts neither way, and frees the probe if it was one.
- With no provider in use the call fails at once with `provider_unavailable` and no attempts. The cost of a call is the sum over its attempts (`result.costMicros`, `error.costMicros`).
- The state is in memory and per process (ADR 0040).

## Budgets

```ts
const budget = createMemoryBudget({
  // The limits come from the ledger: not from the caller, and not from the request.
  limits: (organisationId) => ({ organisationMonthlyMicros: 20_000_000, taskMicros: 2_000_000 }),
});
createModelGateway({ providers, policy, budget });
```

- **Before each attempt** at a provider the gateway reserves room for the **worst** that the attempt can cost: the input as guessed (which errs towards too big) and all of the output that the request allows, at that provider's price. With no room the call fails with `budget_exceeded` (not retryable) and the provider is not asked. A ledger that cannot be read fails it with `budget_unavailable` (retryable), and nothing is sent.
- **After** the attempt the reservation is settled with what it was **charged**: the cost where the provider said what it used (even for an answer that could not be used); the **worst case** where it may have billed and did not say (it was too slow, the caller left, its usage was not a count, an adapter failed with an error of its own); and nothing where it cannot have (it could not be reached, it limited the requests, it rejected the request). `attempts[].chargedMicros`, `result.chargedMicros` and `error.chargedMicros` say so; `costMicros` stays what the providers said.
- An organisation has a limit for each calendar month (UTC) and always has it. A task (`taskId` in the call's context, an opaque id from platform code) has a limit of its own, which a call with no task does not have. An organisation whose limits nobody set is refused.
- Calls made at once cannot pass a limit together: each reserves before it is sent. A charge can pass what was reserved if the guess of the input was low, and the next call is then refused.
- A reservation that is never settled stays counted as spent at its worst case. A ledger that fails to settle does not fail a call that was paid for; the log says so, with an amount and nothing that the ledger said.
- `createMemoryBudget` is **per process, forgets on restart, and keeps an entry for every task**: tests and development only. A deployment with several processes and a ledger like it would allow the limit to each. `unlimitedBudget()` stops nothing. **[`@codemugs/model-budget`](../model-budget/README.md) is the ledger for a deployment**: in PostgreSQL, shared by every process, append-only, with limits that an operator sets and the application cannot (ADR 0042). When it settles, the gateway tells the ledger what the attempt was (the provider's and model's names, an outcome code, the token counts) and never anything that was said.

## Writing an adapter

A provider is `{ name, model, capabilities, price, complete(request) }`. `complete` gets the system and user text, the JSON schema and the signal, and returns the text, the usage and why it stopped. It throws `ProviderFailure` with one of four kinds (`unavailable`, `rate_limited`, `timeout`, `rejected`) and **never puts the provider's message in it**, which can echo the prompt. Prices are whole millionths of a dollar for a million tokens, and are the adapter's configuration, not constants of this package.

`createMockProvider` is a scripted provider for tests, with answers, failures, hangs and crashes in order, and a record of what it was asked (so it holds prompts: tests only).

## Not shown

A real provider's answers and failures (the adapter is tested against a stand-in server, not the real API, and the failover tests inject failures through a mock), a breaker that is shared between processes or survives a restart (a budget ledger that does is in `@codemugs/model-budget`), and who sets the limits. The data classes that may leave the platform are a [draft](../../docs/security/data-classification.md) for the owner to confirm. Redaction is not a guarantee. The token count before a call is a guess that errs towards too big (three ASCII characters to a token, two tokens for every other character, for Chinese, Japanese and Korean text); what is accounted is the provider's. A call that is given up on (time or caller) has no usage, so the budget is charged its worst case.

## Tests

`pnpm --filter @codemugs/model-gateway test`. No database or network. Faults were planted in the gateway one at a time (41 in the core, 45 more in the breaker and the failover, and 66 in the budget; among them a breaker that never opens, one that lets several probes through, failing over on an answer that was no good, ignoring the limit of attempts, adding up the cost of the last attempt only, a budget that is not asked or whose refusal is ignored, a worst case that leaves out the output, an attempt that is not settled, a caller who leaves and is charged nothing, a ledger that fails to settle failing the call, and a reservation that is granted late and never given back; and, in the core, including sending a class the policy did not name, failing open, not removing a secret, not giving up on a provider that ignores the signal or on a policy that does not answer, logging a task that is not well formed, losing the usage of an unusable answer, using a truncated or invalid answer, and rounding the cost down) and each is caught by a test.
