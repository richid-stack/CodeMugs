# Glossary

| Term                               | Meaning                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Control plane**                  | Organisations, projects, integrations, permissions, policies, configuration, billing and orchestration.                                              |
| **Data and intelligence plane**    | Collecting application information, building understanding, detecting problems, investigating, deciding and executing engineering work.              |
| **Organisation (tenant)**          | The unit of customer isolation. Every tenant-owned record belongs to exactly one organisation.                                                       |
| **Project**                        | A scope within an organisation with its own permissions, integrations and applications.                                                              |
| **Application Intelligence Graph** | The structured, continuously updated model of an application: components, endpoints, tables, deployments, incidents and their relationships.         |
| **Application digital twin**       | The model of how an application works (architecture, dependencies, behaviour, configuration, state). Not a literal copy of the application.          |
| **Signal**                         | A piece of evidence about application behaviour: a log, metric, trace, exception, deployment event, or customer report.                              |
| **Correlation**                    | Evidence that signals are related. Never treated as proof of causation.                                                                              |
| **Finding**                        | An issue or opportunity identified by the engine, carrying evidence and a confidence level.                                                          |
| **Hypothesis**                     | A candidate explanation for a finding, tested against supporting and contradicting evidence.                                                         |
| **Diagnosis**                      | A ranked set of hypotheses with evidence, confidence, affected components and user impact. May conclude that evidence is insufficient.               |
| **Evidence ledger**                | The record linking each important decision to the evidence behind it.                                                                                |
| **Decision engine**                | Scores findings and chooses the next action: observe, gather evidence, recommend, investigate, prepare a fix, request approval, act, escalate.       |
| **Autonomy level**                 | How much the platform may do without a human: 0 observe, 1 recommend, 2 prepare changes, 3 execute approved low-risk changes, 4 controlled autonomy. |
| **Policy engine**                  | Enforces autonomy levels, approvals and permissions. Independent of agents.                                                                          |
| **Agent runtime**                  | An existing engineering agent system (OpenHands, Claude Code, Codex, Gemini CLI) used as a replaceable worker.                                       |
| **Agent role**                     | A logical responsibility such as investigator, backend engineer or code reviewer. Not necessarily a separate model.                                  |
| **Sandbox**                        | An isolated execution environment with resource limits, restricted network egress and temporary credentials.                                         |
| **Model gateway**                  | The provider-independent layer for model access: routing, failover, token and cost accounting, structured output validation.                         |
| **Connector**                      | An integration with an external system implementing the common connector interface (authenticate, discover, collect, subscribe, health).             |
| **Engineering memory**             | Structured, provenance-tracked records of past incidents, solutions and outcomes. Supporting evidence, never unquestionable truth.                   |
| **Outcome**                        | The measured result of a change: whether the diagnosis was right, the fix worked, and nothing regressed.                                             |
| **Change intelligence**            | Understanding what changed (commits, deployments, dependencies, configuration) before something broke.                                               |
| **Vertical slice**                 | The first milestone: one complete path from connecting an application to a verified, monitored engineering change.                                   |
