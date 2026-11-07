# GitHub repository setup

A checklist of settings to apply when the repository is created. Menu names change over time, so treat the paths as hints and check what your plan offers. Items marked **plan-dependent** may require a paid plan for private repositories.

## Create it

- [x] Owner: `richid-stack`. Name: `CodeMugs`.
- [x] Visibility: **private**.
- [x] Create it **empty**: no README, license or `.gitignore`, so the first push is a clean history.

## Branch protection (Settings, Rules)

> **Status: not applied.** Attempted on 2026-11-07. For this private repository, both the rulesets API and the classic branch protection API answered `403: Upgrade to GitHub Pro or make this repository public to enable this feature`. Separately, the session's proxy refused the write call. Options:
>
> 1. Upgrade the owner account to GitHub Pro (or move the repository to an organisation on a paid plan), then apply the ruleset below in the web interface.
> 2. Make the repository public. Not advised while the project is proprietary and pre-alpha.
> 3. Until protection is enforceable, work by convention: changes go through pull requests and CI must be green before merging. Nothing enforces this, and the first commits went straight to `main`.
>
> Related security features for private repositories (secret scanning, push protection, code scanning) are plan-dependent too. See the next section.

Protect `main` with a ruleset that:

- [ ] Requires a pull request before merging.
- [ ] Requires status checks to pass: `Build, typecheck, lint, test`, `Dependency audit`, `Secret scan`, `Build API image`.
- [ ] Requires branches to be up to date before merging.
- [ ] Blocks force pushes and deletion.
- [ ] Requires conversation resolution before merging.
- [ ] Optionally requires review from code owners (see `.github/CODEOWNERS`) once there is more than one contributor.

## Security (Settings, Code security)

- [ ] Dependabot alerts on. Dependabot security updates optional alongside Renovate.
- [ ] Secret scanning and push protection on. **Plan-dependent** for private repositories.
- [ ] Private vulnerability reporting on, if offered. [SECURITY.md](../../SECURITY.md) points reporters there. If it is not available, replace that section with a contact address.
- [ ] Code scanning (CodeQL) once the repository is public or the plan includes it. **Plan-dependent.**

## Actions (Settings, Actions)

- [ ] Default workflow token permissions: **read-only**. The workflows request what they need.
- [ ] Limit actions to those you trust. Renovate pins third-party actions by digest.

## Dependency updates

- [ ] Install the Renovate GitHub app on this repository. `renovate.json` is already configured.

## Secrets

None are needed yet. When they are, use environment-scoped secrets, never repository-wide secrets for production.
