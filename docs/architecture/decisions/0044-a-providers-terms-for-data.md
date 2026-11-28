# 0044. A provider's terms for data, apart from the organisation's policy

- **Status:** Accepted.
- **Date:** 2026-11-28

## Context

The model gateway decides what may leave the platform with a **policy**, which is the platform's and the organisation's rule for each class of data ([ADR 0039](0039-the-model-gateway.md), decision 3). It does not look at **where** the data goes. Until now that did not matter: there was one real provider and nothing was switched on.

It matters now, because the owner cannot pay for a provider yet and wants to try free tiers (Groq and the Gemini API), with a paid provider later, and a gateway that takes any of them. A free tier is often free because of what the provider may do with what it is sent. Read on 2026-11-28:

- **Gemini API, unpaid services** ([the provider's terms](https://ai.google.dev/terms)): Google uses the content that is submitted, and the responses, to improve its products; human reviewers may read, annotate and process it (disconnected from the account and key first); and the terms say **not to submit sensitive, confidential or personal information** to the unpaid services. The paid services do not use prompts to improve products and log them only for a limited time, to detect abuse.
- **Groq** ([data controls](https://console.groq.com/docs/your-data)): inference prompts and outputs are not retained by default; logs for reliability and abuse can be kept for up to 30 days; zero data retention can be switched on by the organisation. The page does not say whether Groq trains on what it is sent, and does not separate free from paid.

Both are the provider's words on a day; they change, and this record is not legal advice. The point is the structure: **a provider has terms, those terms are a second reason to send or not to send, and nothing in the gateway could say so.** With a policy that permits a class and two providers in a failover list, a free tier that may read what it is sent could be the one that is tried when the first fails.

## Decisions

1. **A provider declares the classes of data it may be sent**: `capabilities.dataClasses`, a list of the data classes of the [data classification](../../security/data-classification.md). It is the deployment's declaration, from the terms it has read, and is not inferred by an adapter: the same adapter and endpoint have different terms on a free and a paid key. `[]` means a request that holds no data (instructions only).
2. **Both must allow it.** The organisation's policy says what may leave; the provider's list says what **this provider** may have. A class that either does not permit is not sent. A provider's list narrows the policy and **never widens it**: a class the policy does not permit is not sent to a provider that lists it (`not_permitted`).
3. **A provider that may not have a class that the request holds is not a candidate**, for the call or for a failover. It is not tried first, and it is not tried when another provider fails. If no provider may have the request's classes, nothing is sent, nothing is reserved from the budget, and the call fails with **`no_permitted_provider`**, a code of its own, not retryable (another try changes nothing; the configuration does). The class is decided before the size, so a provider that has room and may not have the data is not one.
4. **Absent means the policy alone decides**, as before, so that nothing that exists changes. **An adapter for an endpoint that may be a free tier must make the deployment say**: the adapter for OpenAI-compatible endpoints (ADR 0045, planned) requires the list and has no default.
5. **A list that is not a list of classes refuses the gateway at creation** (`RangeError`), as a price that is not valid does.

## Consequences

- A free tier can be used **now**, for what has no sensitivity (the platform's own synthetic text, the demo application's synthetic telemetry), without a way for a real customer's data to reach it by a failover or a configuration slip. The first deployment lists `[]` or `platform_metadata` for a free tier.
- Which classes a real provider may be given is still the owner's decision ([open question 6](../open-questions.md)); this record gives the place where it is written, not the answer.
- **Not decided:** whether `source_code` or `personal` may ever go to a provider that trains on what it is sent. The default for those is that they do not.
- Tested with no network: a class that is not listed is never sent, not even by failover; every class of a request must be listed; a request with no data goes to a provider that may have none; the provider's list never widens the policy; nothing is reserved when nothing is permitted; a list that is not a list is refused. 12 faults planted in the new rule and its validation: 12 caught.
- **Not shown:** that the terms above are what apply to a given key (the owner reads them for the account that is used), and that a provider's terms stay what they were.
