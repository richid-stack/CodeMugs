# @codemugs/model-gateway

Provider-independent access to language models: one interface in front of any provider, with what may be sent decided by the organisation's policy, instructions kept apart from untrusted data, secret-like strings removed, the answer checked against a schema, and what a call cost worked out. The product is never hard-wired to one provider.

**Status:** Phase 1 · Foundation, step 8, first part ([ADR 0039](../../docs/architecture/decisions/0039-the-model-gateway.md)). The core and a mock provider exist and are tested. **There is no adapter for a real provider yet**, nothing calls the gateway, and there is no failover, budget or stored usage (parts two and three). Release gates 16 and 17 are **not started**: nothing here is shown to survive a provider's failure or to stop spending.

## What it does

```ts
import { createModelGateway, createMockProvider, permitClasses } from "@codemugs/model-gateway";
import { z } from "zod";

const gateway = createModelGateway({
  providers: [createMockProvider({ steps: [{ value: { summary: "…", confidence: 0.8 } }] })],
  policy: permitClasses(["repository_facts"]), // what the organisation lets go; the default sends nothing
});

const result = await gateway.call(
  { organisationId, signal }, // the organisation comes from the caller's authority, never from a request body
  {
    task: "diagnose",
    instructions: "Say what is wrong.", // written by the platform; nothing from a customer goes here
    data: [{ label: "routes", dataClass: "repository_facts", content: facts }], // untrusted
    output: z.object({ summary: z.string(), confidence: z.number() }),
    maxOutputTokens: 500,
  },
);
// result.value (checked), result.provider, result.inputTokens, result.outputTokens, result.costMicros, result.redactions
```

For each call, in this order:

1. **The request is checked**: names, labels, classes, sizes and the organisation's id (`invalid_request`), and the schema must be an object.
2. **The policy is asked** which classes of data may go to a provider for this organisation, and a class that it does not name does not go (`not_permitted`). A policy that cannot be read sends nothing (`policy_unavailable`). `denyAll` is the default; `permitClasses` is for tests and for a deployment that has decided.
3. **Secret-like strings are removed** from the data (private keys, passwords in URLs, cloud keys, tokens, values of names that say they are secret) and counted. It is a second line: the rule is that none is put in a request. Instructions that hold one are refused.
4. **Instructions and data are kept apart**: the instructions are the system message, and each piece of data is a block between lines with a boundary made for the request and found in none of the content, so content cannot close its block (invariant 2). Labels are checked, so they cannot either.
5. **A provider is chosen** that has room for the request and the answer (`no_capable_provider`). It is called with the time that the gateway allows and is given up on when the time is up (`timeout`) or the caller leaves (`aborted`), **even if the adapter ignores the signal**.
6. **The answer is data until checked**: it must have stopped by itself (`output_truncated`, `refused`), be JSON (one code fence is allowed) and fit the schema (`output_invalid`). Usage that is not a count is a fault of the adapter and is not accounted.
7. **The cost** is worked out in whole millionths of a US dollar from the provider's price, rounded up, with no float.

A failure is a `ModelError` with a short code, whether another try could do better (`retryable`) and a fixed sentence. **Nothing of a prompt, an answer, a provider's message or a policy's error is in it or in the log.** The log has the task, organisation, provider, model, tokens, cost, redaction count and the outcome code.

## Writing an adapter

A provider is `{ name, model, capabilities, price, complete(request) }`. `complete` gets the system and user text, the JSON schema and the signal, and returns the text, the usage and why it stopped. It throws `ProviderFailure` with one of four kinds (`unavailable`, `rate_limited`, `timeout`, `rejected`) and **never puts the provider's message in it**, which can echo the prompt. Prices are whole millionths of a dollar for a million tokens, and are the adapter's configuration, not constants of this package.

`createMockProvider` is a scripted provider for tests, with answers, failures, hangs and crashes in order, and a record of what it was asked (so it holds prompts: tests only).

## Not shown

A real provider, whether any of this holds under a provider's real failures, failover and a circuit breaker, a budget that stops spending, and usage that is kept. The data classes that may leave the platform are a [draft](../../docs/security/data-classification.md) for the owner to confirm. Redaction is not a guarantee. The token count before a call is a guess (three characters to a token); what is accounted is the provider's.

## Tests

`pnpm --filter @codemugs/model-gateway test`. No database or network. Faults were planted in the gateway one at a time (28, including sending a class the policy did not name, failing open, not removing a secret, not giving up on a provider that ignores the signal, using a truncated or invalid answer, and rounding the cost down) and each is caught by a test.
