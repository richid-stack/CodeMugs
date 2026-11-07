## What and why

<!-- What does this change, and what evidence or requirement motivated it? -->

## Checklist

- [ ] `pnpm verify` passes locally
- [ ] Tests cover the new behaviour, including failure paths
- [ ] Tenant identity comes from the authenticated credential, never from request payloads
- [ ] No secrets, tokens or personal data in code, logs, fixtures or prompts
- [ ] Anything that handles untrusted input (repo contents, logs, webhooks, user messages) treats it as data, not instructions
- [ ] Docs updated, and an ADR added in `docs/architecture/decisions/` if this changes an architectural decision
- [ ] Relevant [release gates](../docs/operations/release-gates.md) reviewed

## Risks and rollback

<!-- What could go wrong, and how would we undo this? -->
