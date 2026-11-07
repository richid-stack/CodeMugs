# Threat model (draft)

> **This is a starting point for Phase 0, not a completed threat model.** It lists what must be analysed. Each row needs an owner, a concrete mitigation, and a test before the corresponding release gate can be closed.

## What we are protecting

- Customer source code and repository access
- Credentials for connectors (GitHub, cloud providers, databases)
- Customer telemetry and any personal data inside it
- The integrity of decisions, audit records and engineering changes
- The platform's own infrastructure and every other tenant's data

## Trust boundaries

1. Internet to ingestion gateways and the API
2. Tenant to tenant, inside shared infrastructure
3. Platform to agent sandbox
4. Sandbox to the outside world (egress)
5. Platform to model providers
6. Platform to customer systems through connectors

## Untrusted input

Treated as data, never as instructions: repository contents (including READMEs, comments and issues), logs, telemetry attributes, webhook payloads, documentation retrieved from the web, support tickets, reviews and customer messages, and the output of any model or agent.

## Threats to analyse

| #   | Threat                                                                        | Primary mitigations to design and test                                                                                                                                                             | Earliest phase |
| --- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | One tenant reads or affects another tenant's data                             | Tenant identity derived from credentials only; tenant-scoped storage layer; automated cross-tenant tests                                                                                           | 1              |
| 2   | Spoofed or forged ingestion events                                            | Authenticated gateways, request signing where applicable, schema validation, rate and size limits, idempotency                                                                                     | 2              |
| 3   | Prompt injection through repository content, logs or tickets                  | Treat all such content as untrusted data; separate instructions from data; tool permission boundaries; human approval gates                                                                        | 4              |
| 4   | An agent exceeds its permissions or grants itself more                        | Policy engine independent of agents; deny by default; scoped temporary credentials                                                                                                                 | 5              |
| 5   | Sandbox escape or abuse of execution resources                                | Hardened container first, then stronger isolation (gVisor or microVM) before third-party code runs in the hosted service; resource, process and time limits; no standing credentials; see ADR 0007 | 1-2            |
| 6   | Source code or secrets exfiltrated by an agent                                | Network egress default-deny with allow-lists; secrets never in prompts or logs; artifact review                                                                                                    | 2              |
| 7   | Connector credential theft or misuse                                          | Encryption with KMS, narrow scopes, rotation, short-lived execution credentials, access auditing                                                                                                   | 1-2            |
| 8   | Sensitive data leaks through telemetry or model prompts                       | Redaction in SDKs and at gateways, before storage and before any model call; retention limits                                                                                                      | 2              |
| 9   | Audit records altered or deleted                                              | Append-only audit storage, restricted write paths, integrity checks                                                                                                                                | 1              |
| 10  | Compromised dependency or build artifact                                      | Pinned dependencies, lockfile, dependency scanning, Renovate, signed artifacts                                                                                                                     | 1              |
| 11  | Denial of service or runaway cost (including model spend)                     | Rate limits, backpressure, per-tenant and per-task budgets, circuit breakers                                                                                                                       | 1              |
| 12  | Model provider outage or data handling concern                                | Provider-independent gateway, failover, provider data-handling review                                                                                                                              | 1              |
| 13  | Confident but wrong diagnosis drives a harmful change                         | Evidence requirements, "insufficient evidence" outcome, independent validation, approval levels                                                                                                    | 4              |
| 14  | Analysing an untrusted repository exploits a parser or executes customer code | Analysis runs inside the sandbox with the analysis profile: read-only source, no network, no credentials, resource limits. No install, build or test scripts during analysis. See ADR 0007         | 2              |

## Next steps

- Assign an owner to each row.
- Add data flow diagrams for ingestion, repository analysis, and agent execution.
- Convert mitigations into tests under `tests/security`.
- Review the model before Phase 5 begins and again before any production use.
