# Landing page

**Status: draft concept. Not deployed.** One self-contained page, `index.html`, with no build step and nothing to install. It is the public face the product is aiming for, not a description of what exists today. Most of what it shows is not built yet (see [What exists today](../README.md#what-exists-today)), so it must not be put online as it stands.

## Preview

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server --directory site 8080
```

It works at phone width. It asks search engines not to index it (`noindex`), so that an accidental deployment does not end up in search results.

## What was changed when it was added

The design and copy are the owner's. Three things were changed, because they would have said something false:

- The row of six customer names and logos was removed. CodeMugs has no customers, and some of the names look like real companies.
- The REST sample now shows the request the API really accepts: `Authorization: Bearer cmk_…` and a body of `{ "events": [ … ] }`. It had a key prefix and a body that do not exist.
- The footer named another brand when scripts are off. It now says CodeMugs.
- `noindex` was added.

## Before it goes live

Each row is something the page says that is not yet true, or that needs a decision. Release gates and invariant 7 in [AGENTS.md](../AGENTS.md) apply to a marketing page as much as to docs.

| The page says                                                                                                           | The truth today                                                                                                                                    | What to do                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| "Fifteen ways to connect", "124+ tools and platforms", logos of dozens of products                                      | Two exist: a read-only GitHub App client and `POST /v1/events`. Everything else is planned                                                         | Say how many exist. Show a product's logo only once its integration exists, and follow that brand's guidelines |
| `npm i @codemugs/sdk`, `pip install codemugs`                                                                           | No SDK is published, and the names are not reserved                                                                                                | Remove the commands until the packages exist, and reserve the names first                                      |
| `otlp.codemugs.io`, `mcp.codemugs.io`, `cdn.codemugs.io/web.js`                                                         | Nothing is served there, and it is not confirmed that the domain is owned                                                                          | Never print a snippet that loads a script from a domain that is not under your control                         |
| Webhooks with `X-CodeMugs-Signature`, a CLI, a collector agent, an MCP server, browser instrumentation, a connector SDK | Not started                                                                                                                                        | Mark as coming, or remove                                                                                      |
| Product screens (repository picker, application map, investigations, approvals, live signals)                           | Illustrations with invented data. There is no frontend                                                                                             | Label them as illustrations                                                                                    |
| JavaScript, TypeScript and Python understanding                                                                         | The analyser reads TypeScript and JavaScript only                                                                                                  | Drop Python until it exists                                                                                    |
| Approvals, scoped access, autonomy levels, an audit trail                                                               | Designed ([architecture overview](../docs/architecture/overview.md)). The policy engine is not built. An audit log exists for API key actions only | Describe it as designed, not as a feature. Make no compliance claim without the evidence                       |
| "Verified improvements", "independent checks"                                                                           | The goal, and the design rule. No change is produced or verified yet                                                                               | Keep as the goal, in the future tense                                                                          |
| Footer links: Docs, Careers, Blog, About, Privacy, Terms, Contact, "Talk to our team"                                   | None of these pages exists                                                                                                                         | Remove the links or write the pages. A privacy policy and terms are needed before collecting anything          |
| "© CodeMugs. All rights reserved."                                                                                      | The code's [licence](../LICENSE) names Richard Mensah as the copyright holder                                                                      | Decide who the copyright holder is                                                                             |
| Fonts from Google Fonts                                                                                                 | Each visitor's address is sent to Google                                                                                                           | Host the fonts yourself if that matters to your audience (both are SIL OFL)                                    |

When a row is resolved, delete it from this table. When the table is empty, remove `noindex` from `index.html`.

## Brand

The logo files are in [`../assets/brand`](../assets/brand/README.md). The page uses Space Grotesk Bold for the name and Geist and Geist Mono for the rest, on a near-black ground (`#050507`) with a pale blue (`#bdd0fb`) band.
