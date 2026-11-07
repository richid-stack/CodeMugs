# Product requirements (draft)

> **Draft.** Derived from the architecture brief. Sections that depend on decisions only the owner can make are listed under [Open questions](#open-questions). Until those are answered this is a working outline, not an agreed specification.

## Purpose

Close the loop between what an application does in production and the engineering work needed to improve it: understand the application, notice when it behaves differently, work out why, decide what to do, do the work safely, and check whether it helped.

Collecting errors is not understanding an application. The product builds a structured, continuously updated model of the application and reasons over it.

## Who it is for

Software companies that would trust it with production systems. The first application it will serve is OpenLobs.

## What it does

1. **Connect** repositories, deployed applications and other sources through SDKs, OpenTelemetry and connectors.
2. **Understand** the application's structure and behaviour as a graph.
3. **Detect** unusual behaviour with statistical methods.
4. **Investigate** by generating and testing competing hypotheses against evidence.
5. **Decide** what to do within the customer's autonomy and approval policies.
6. **Act** by delegating engineering work to agent runtimes inside isolated sandboxes.
7. **Verify** changes independently of the agent that made them.
8. **Learn** from measured outcomes.

## First milestone

Connect an application, understand it, detect a problem, investigate it and produce a verified engineering change. The detailed steps are in the [roadmap](../engineering/roadmap.md). The milestone is met when that path runs reliably, not when each piece merely exists.

## Requirements that define trust

- Strict tenant isolation.
- Findings carry evidence, and the system can say "insufficient evidence".
- Agents cannot exceed their permissions, and high-risk changes (payments, authentication, migrations, permissions) need explicit human approval.
- A change counts as resolved only when verified in the real application.
- Every important decision is traceable.

The full list is the [release gates](../operations/release-gates.md).

## How success is measured

From outcome tracking: was the diagnosis correct, did the fix work, did tests catch the problem, did the change cause regressions, how much investigation time was saved, did customer experience improve, and did infrastructure cost change.

## Non-goals for now

- A frontend. The engine is built and proven first, and what the frontend should be will be clearer once it works.
- Billing.
- Self-hosted packaging ([ADR 0002](../architecture/decisions/0002-hybrid-deployment.md)).
- Any compliance claim before the controls exist and have been audited.
- Broad connector coverage. The connector list in the architecture is a set of examples, not commitments.
- Unattended changes to high-risk areas.

## Open questions

- Who is the first target customer segment, and who inside those companies approves and uses the product?
- Which languages and frameworks must the first milestone support?
- What autonomy level is the default for a new customer?
- What is the pricing model? It determines what must be metered.
- What does "verified" mean for a customer whose application has little or no test coverage?

See also [gaps and open questions](../architecture/open-questions.md) for architectural gaps.
