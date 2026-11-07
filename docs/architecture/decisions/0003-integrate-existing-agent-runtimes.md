# 0003. Integrate existing agent runtimes, build our own orchestration and intelligence

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

Serious engineering agent runtimes already exist (OpenHands, Claude Code, Codex, Gemini CLI). Recreating them would consume years without differentiating the product. What is distinctive is deciding what engineering work needs doing, supplying the right context, and validating and constraining the result.

The options were to integrate existing runtimes, build a complete runtime ourselves, or integrate first and replace selectively.

## Decision

Integrate existing runtimes behind one adapter interface (`engineering/code-execution`). Build our own orchestration, context building, decision making, policy, validation and learning.

## Consequences

- Agents are replaceable workers. No prompt, tool or data format may couple the platform to a single vendor.
- Every runtime runs inside our sandbox with scoped, temporary credentials and an egress policy. The sandbox is a hard prerequisite before any agent executes code.
- We need repeatable agent evaluations (`tests/agent-evaluations`) to compare runtimes on real tasks rather than on reputation.
- Success is judged by our validation layer, never by the agent's own report.

## Revisit when

Evaluations show a runtime limitation we cannot work around, in which case a purpose-built execution layer for that gap is considered.
