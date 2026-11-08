# 0008. License the engine under the Functional Source License

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

The owner wants the source to be readable, so that customers who will give the platform access to their code can inspect what it does. The owner does not want it to be open source: others must not be able to take it and offer a competing product. The repository is about to become public, so a licence has to be in place first.

Options discussed: keep all rights reserved, AGPL-3.0 with a commercial licence and a contributor agreement (CLA), or the Functional Source License (FSL).

## Decision

1. Everything in this repository is licensed under **FSL-1.1-ALv2** (Functional Source License, Version 1.1, Apache 2.0 Future License), Copyright 2026 Richard Mensah. The text in `LICENSE` is the official template with only the year and the licensor filled in.
2. In practice: anyone may use, copy, modify and redistribute the software for any purpose except a Competing Use, which means offering it to others as a commercial product or service that substitutes for it or does the same job. Internal use, non-commercial education, non-commercial research and professional services for a licensee are explicitly permitted. Each version becomes available under the Apache License 2.0 on the second anniversary of its release, and that grant is irrevocable.
3. We describe it as **source-available**. We do not call it open source, because it is not open source by the Open Source Definition.
4. The licence for SDKs and other code that runs inside customers' applications is not decided here. Apache-2.0 is proposed. See [open question 17](../open-questions.md).
5. No outside contributions are accepted until a contributor agreement (CLA) exists.

## Consequences

- A customer running the software for their own internal use is a permitted purpose, so the self-hosted option in [ADR 0002](0002-hybrid-deployment.md) needs commercial terms for support, not a separate licence.
- The licence grants no trademark rights. The name CodeMugs needs separate protection if it matters.
- A published version stays available under FSL, and under Apache-2.0 after two years, whatever is decided later. As sole copyright holder the owner can license future code differently, but cannot withdraw what has been published.
- Some companies only allow licences approved by the Open Source Initiative. Customers using the hosted service are unaffected. Customers who self-host may need their legal team to read a short licence.
- Dependencies must be checked for licence compatibility before the first external release.
- This is the owner's decision. The owner is handling legal review personally, and this record is not legal advice.

## Alternatives considered

- **All rights reserved.** Keeps every option open, but grants nobody any right and is a poor signal for a product that wants to be audited.
- **AGPL-3.0 plus a commercial licence and a CLA.** Real open source, and protects against hosted clones. Some corporate legal teams avoid AGPL, and dual licensing needs a CLA from every contributor.
- **Apache-2.0 or MIT.** Maximum adoption, but nothing stops a competitor hosting it.

## Revisit when

Before the first outside contribution (the CLA), before the first SDK release, or if a customer's policy makes the licence a blocker.
