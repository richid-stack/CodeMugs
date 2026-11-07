# Data classification (draft)

> **Draft.** The handling rules below are proposals for the owner to confirm. Retention periods are deliberately undecided. Every store must be able to delete and expire data regardless of the periods chosen.

| Class                      | Examples                                                             | Handling rules (proposed)                                                                                                                           | May be sent to model providers (proposed)                          | Retention |
| -------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------- |
| Secrets                    | Connector credentials, API keys, environment variable values, tokens | Encrypted with a KMS. Never in logs, prompts or fixtures. Short-lived credentials for execution. Environment variable names recorded, never values. | Never                                                              | TBD       |
| Source code                | Repository contents, diffs, source snapshots                         | Customer confidential. Stored only where permitted and for a limited time. Analysed statically before anything is executed.                         | Only if the tenant's policy allows and provider terms are reviewed | TBD       |
| Operational telemetry      | Logs, traces, metrics, exceptions, deployment events                 | Redacted in SDKs and again at the gateway, since it can contain personal data by accident. Retention configurable per tenant.                       | After redaction, per tenant policy                                 | TBD       |
| Personal and behavioural   | Pseudonymous user identifiers, journey events, session data          | Collected only with explicit permission. Pseudonymous identifiers. Configurable retention.                                                          | No by default                                                      | TBD       |
| Customer communications    | Support tickets, reviews, feedback, complaints                       | Explicit permission, redaction, configurable retention. Treated as untrusted input.                                                                 | No by default                                                      | TBD       |
| Model requests and outputs | Prompts, completions, tool calls                                     | Logged only with sensitive data controls. May contain any class above and inherits the strictest.                                                   | Not applicable                                                     | TBD       |
| Platform metadata          | Organisations, projects, policies, findings, tasks, evidence, memory | Tenant-scoped. Memory entries carry provenance and a review policy.                                                                                 | Per the classes of data they reference                             | TBD       |
| Audit records              | Who did what, approvals, policy decisions, access to tenant data     | Append-only. Restricted write paths. Includes operator access.                                                                                      | No                                                                 | TBD       |

## Rules that apply to every class

- Redaction happens before transmission and before storage, not after.
- Deletion works across every store: primary database, analytical store, cache, object storage and backups' expiry.
- Region is recorded per tenant so residency options stay open.
- The strictest class present in a piece of data governs how it is handled.

## Decisions needed

- Retention period for each class, and the defaults for new tenants.
- Which data classes may leave the platform for model providers, and how a tenant overrides that.
- How long backups keep deleted data, and how that is communicated to customers.
