# @codemugs/model-provider-anthropic

An adapter for the [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages), behind the [model gateway](../model-gateway/README.md). It is the first real provider.

**Status:** Phase 1 · Foundation, step 8, part five ([ADR 0043](../../docs/architecture/decisions/0043-an-adapter-for-the-anthropic-messages-api.md)). Written against the provider's documentation and tested against a stand-in server on this machine. **It has not been run against the real API**: there is no key yet, so nothing has been sent to the provider, and whether the provider accepts the request as written is **not shown**. Nothing creates it or calls the gateway. Gates 16 and 17 are in progress, not closed.

## Use

```ts
import { Secret } from "@codemugs/configuration";
import { createModelGateway } from "@codemugs/model-gateway";
import { createAnthropicProvider } from "@codemugs/model-provider-anthropic";

const provider = createAnthropicProvider({
  apiKey: new Secret(process.env.CODEMUGS_MODEL_API_KEY ?? ""),
  model: "<the model's name>",
  // From the provider's price list, in whole millionths of a US dollar for a million tokens.
  // Required and never guessed: the budgets are worked out from it.
  price: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
  maxContextTokens: 200_000,
  maxOutputTokens: 8_000,
});

const gateway = createModelGateway({ providers: [provider], policy, budget });
```

## What it does, and does not

- **One request, one answer.** No retry, failover, accounting or policy: the gateway does those.
- **Structured output is the provider's** (`output_config.format`). The schema is converted for it: constraints that the provider refuses are written into the description, every object is closed, and a schema that would mean something else once converted (a record) is **refused before anything is sent**.
- **Every failure is one of four kinds**, by whether it can have been billed (a timeout and a dropped connection are charged for, a refused request is not). What the provider said is never kept: an error is a kind or a fixed sentence.
- **Redirects are not followed**, so the key cannot be taken elsewhere. The key is a `Secret`, stays in a closure, and is a header and nothing else.
- Nothing that identifies a person or an organisation is sent.

## Not built

A live test (it needs the owner's key and a spend cap), streaming, wiring, and reading the key from the environment. Which data may reach a provider at all is the gateway's policy, and is nothing by default.

## Tests

`pnpm --filter @codemugs/model-provider-anthropic test`. No database and no network: the tests talk to a server that they start on 127.0.0.1.
