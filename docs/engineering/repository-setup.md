# GitHub repository setup

A checklist of settings to apply when the repository is created. Menu names change over time, so treat the paths as hints and check what your plan offers. Items marked **plan-dependent** may require a paid plan for private repositories.

## Create it

- [x] Owner: `richid-stack`. Name: `CodeMugs`.
- [x] Visibility: **private**.
- [x] Create it **empty**: no README, license or `.gitignore`, so the first push is a clean history.

## Branch protection (Settings, Rules)

> **Status: not applied.** On 2026-11-07 the rulesets API and the classic branch protection API both answered `403: Upgrade to GitHub Pro or make this repository public to enable this feature` for this private repository, and the engineering session's proxy refuses write calls to those endpoints anyway. The plan is to make the repository public (checklist below) rather than pay for Pro, then apply the ruleset by hand:
>
> 1. Settings, Rules, Rulesets, New ruleset, **Import a ruleset**, and choose [`.github/rulesets/protect-main.json`](../../.github/rulesets/protect-main.json). It requires a pull request, the four status checks and resolved conversations, and blocks force pushes and deletion. It has not been test-imported. If the page rejects it, use the checklist below by hand.
> 2. There are no bypass actors on purpose. If CI is broken and `main` must be fixed, set the ruleset's enforcement to Disabled, fix it, and turn it back on.
> 3. The engineering session can open pull requests through the REST API (`gh pr create` does not work there because it uses GraphQL). Once the ruleset is on, direct pushes to `main` stop working, so every later change goes through a pull request.
>
> Until then, work by convention: pull requests, and CI green before merging. Nothing enforces it, and the first commits went straight to `main`.

Protect `main` with a ruleset that:

- [ ] Requires a pull request before merging.
- [ ] Requires status checks to pass: `Build, typecheck, lint, test`, `Dependency audit`, `Secret scan`, `Build API image`.
- [ ] Optional: require branches to be up to date before merging. Off in the ruleset for now, because it adds a rebase step to every pull request and there is one author. Turn it on when there are several.
- [ ] Blocks force pushes and deletion.
- [ ] Requires conversation resolution before merging.
- [ ] Optionally requires review from code owners (see `.github/CODEOWNERS`) once there is more than one contributor.

## Before making the repository public

Public means anyone can read the code and the documents, including the architecture, the draft product requirements and the threat model. Copyright still applies (see [LICENSE](../../LICENSE)), but copyright protects the text of the code, not the ideas in it.

- [x] History scanned for secrets and personal data on 2026-11-07: no key-like strings, and the only addresses in the history are GitHub's noreply address and the Claude co-author trailer. The CI secret scan passes too.
- [x] `LICENSE` present: all rights reserved.
- [ ] The owner has read the documents once as a stranger would and is happy for them to be public. In particular `docs/product/prd.md`, `docs/security/threat-model.md` and the mentions of OpenLobs.
- [ ] Change visibility: Settings, General, Danger Zone, Change visibility.
- [ ] Straight afterwards: apply the branch ruleset (above), turn on secret scanning, push protection and private vulnerability reporting, and under Settings, Actions, General set approval for workflow runs from outside contributors to require approval for all outside collaborators.

## Security (Settings, Code security)

- [ ] Dependabot alerts on. Dependabot security updates optional alongside Renovate.
- [ ] Secret scanning and push protection on. **Plan-dependent** for private repositories. Expected to be available once the repository is public; confirm in Settings.
- [ ] Private vulnerability reporting on, if offered. [SECURITY.md](../../SECURITY.md) points reporters there. If it is not available, replace that section with a contact address.
- [ ] Code scanning (CodeQL) once the repository is public or the plan includes it. **Plan-dependent.**

## Actions (Settings, Actions)

- [ ] Default workflow token permissions: **read-only**. The workflows request what they need.
- [ ] Limit actions to those you trust. Renovate pins third-party actions by digest.

## Dependency updates

- [ ] Install the Renovate GitHub app on this repository. `renovate.json` is already configured.

## Secrets

None are needed yet. When they are, use environment-scoped secrets, never repository-wide secrets for production.
