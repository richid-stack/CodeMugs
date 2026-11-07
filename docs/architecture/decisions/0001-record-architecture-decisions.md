# 0001. Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

This platform is meant to be trusted with production systems, and it will be built over a long period. Decisions made early will constrain it for a long time, and the reasons behind them are easily lost.

## Decision

We record significant architectural decisions as short numbered documents in this directory, using the format below. A decision is "significant" if reversing it later would be expensive, or if it changes a security or data boundary. Superseded decisions are kept and marked, not deleted.

```markdown
# NNNN. Title

- **Status:** Proposed | Accepted | Superseded by NNNN
- **Date:** YYYY-MM-DD

## Context

## Decision

## Consequences

## Revisit when
```

## Consequences

Pull requests that change an architectural decision add or supersede a record. The pull request template asks for this.

## Revisit when

The overhead stops paying for itself.
