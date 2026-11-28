# @codemugs/model-provider-http

**Status:** Phase 1 · Foundation, step 8. Built and tested; shared by the adapters for model providers that are reached over HTTPS ([ADR 0043](../../docs/architecture/decisions/0043-an-adapter-for-the-anthropic-messages-api.md), ADR 0045, planned). Nothing outside those adapters uses it.

The part of an adapter that is the same whatever the provider: **how a request is sent, and how what comes back is told apart.** It knows nothing of any provider's request or answer, holds no key (the caller gives it the headers, and they go nowhere but the request), and never lets out what the provider said.

- `exchange` sends one POST and returns the text of a 200, or throws a `ProviderFailure` of the kind the failure was, or `UnusableAnswer` for an answer that came, and was probably billed, and cannot be used (the gateway charges the worst case for it). **It never follows a redirect** (`fetch` keeps the headers across one, which would take the key to wherever it points), reads at most 4 MiB of an answer and 64 KiB of an error, and looks at the gateway's signal itself to tell a call that was given up on from one that failed.
- **The four kinds**: 429 is `rate_limited`; 408 and 504 are `timeout` (it ran out of time and **may have been billed**); other 5xx are `unavailable`; every other status, redirects included, is `rejected`. A 500 is asked about with the provider's own function (`kindOf500`): some providers also answer a request that ran out of time with a 500. **A body that cannot be read, or that the function throws on, cannot rule a timeout out, so it is one.** A connection that never left (the name was not found, refused, the certificate was not trusted) is `unavailable`; one that dropped once the request was sent is a `timeout`.
- `checkedBaseUrl`: https, or http on this machine (for tests); no credentials, query or fragment.
- `isName`, `isModel`, `isModelPath`, `isKey`, `isCount`: the checks of the settings that all adapters make.

## Tests

`pnpm --filter @codemugs/model-provider-http test`: 18 tests with no network (a fake `fetch`). 68 faults planted in the code (one, in the cycle guard, was removed as dead code and is not counted), all caught but one that is equivalent (a 500 never reaches the `>= 500` branch). The adapters' own tests, which did not change when this code moved here, are the other half of the evidence.
