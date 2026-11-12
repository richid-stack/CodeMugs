# 0019. Every GitHub Action is pinned to a commit, and a check fails when one is not

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

A workflow runs other people's code with the repository checked out and a token in its environment. `uses: actions/checkout@v4` does not name that code. It names a tag, and whoever controls the action's repository can move the tag to other code at any time, with no commit in ours and nothing to review.

This has happened. In March 2026 the tags of `aquasecurity/trivy-action` (76 of its 77) and of `aquasecurity/setup-trivy` were force-pushed to commits that stole credentials from the runners that used them, and the advice given afterwards was to pin actions to a full commit SHA, which a tag cannot be moved away from ([The Hacker News, 20 March 2026](https://thehackernews.com/2026/03/trivy-security-scanner-github-actions.html)). Our workflows then used four actions by floating major tags (`@v4`, `@v2`), nine references in all. CI here holds no secret beyond the token GitHub gives each run, but it builds and tests the engine that will run customers' code, and the habit of trusting a tag is cheaper to remove now than later.

## Decision

1. **Every `uses:` in `.github/workflows` names a full 40-character commit SHA,** with the release in a comment (`# v4.4.0`). A container image used as an action (`docker://`) is pinned by digest. A file of this repository (`./...`) is allowed.
2. **The commits are the ones the tags pointed to on 2026-11-12,** read from each upstream repository with `git ls-remote`, so CI runs the code it ran before and nothing changes but the ability to move it. An annotated tag lists two lines, and the commit is the peeled one (`^{}`).

   | Action                     | Was  | Release pinned | Commit                                     |
   | -------------------------- | ---- | -------------- | ------------------------------------------ |
   | `actions/checkout`         | `v4` | v4.4.0         | `11d5960a326750d5838078e36cf38b85af677262` |
   | `pnpm/action-setup`        | `v4` | v4.3.0         | `b906affcce14559ad1aafd4ab0e942779e9f58b1` |
   | `actions/setup-node`       | `v4` | v4.4.0         | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
   | `gitleaks/gitleaks-action` | `v2` | v2.3.9         | `ff98106e4c7b2bc287b24eaf42907196329070c7` |

   `pnpm/action-setup` has a v4.4.0, but its `v4` tag still pointed at v4.3.0, so that is what stays. Moving to a newer release is an update and is made as one.

3. **A check fails the build when something is not pinned.** `scripts/check-workflow-pins.mjs` reads every workflow file and reports the file and line of each reference that is not a full SHA (or, for an image, a full digest). It fails closed: a `uses:` it cannot read (inside braces, with the value on the next line, an anchor or alias, an unclosed quote) is reported, not skipped, and a directory with no workflow file is an error, so a wrong path is not a pass. It is a text scan and not a YAML parser, chosen so that it adds no dependency (conventions). It runs in `pnpm verify` and as its own step of the CI job, before anything is installed. Its tests use `node:test`, which ships with Node.
4. **The comment is not checked, and the SHA is what runs.** A comment can be wrong. To update an action: read the new tag's commit from the upstream repository, change the SHA and the comment together in one reviewed commit, and let CI run.
5. **Renovate is not installed, so updates are manual for now.** `renovate.json` extends `helpers:pinGitHubActionDigests` and would propose updates that keep the pins, with the check guarding them. The Renovate GitHub app has to be installed on the repository by its owner, and has not been. The docs that said Renovate proposes updates were changed to say that it will once installed.

## Rejected alternatives

- **Leaving major-version tags and trusting the maintainers.** The Trivy actions were maintained by a security vendor.
- **Pinning without a check.** The next action added by hand with `@v5` would undo it, and nobody would see.
- **Limiting actions to those from GitHub and verified creators in the repository settings.** It is a good second layer and is the owner's to set; it does not stop a tag of an allowed action from being moved.
- **Parsing the workflows as YAML with a library.** It reads more forms than a text scan, at the price of a new dependency in the tool that guards the supply chain. The text scan refuses what it cannot read.
- **Replacing `gitleaks-action` with the gitleaks binary run directly.** It would remove an action but add a download to pin. It is not decided here.

## Not decided, or not done

- **A SHA can belong to a fork.** GitHub resolves a commit that exists anywhere in a repository's fork network under the repository's name. The four SHAs above were compared with the upstream repositories' tags (`git ls-remote` against each, on 2026-11-12). The script does not know the upstream, so a later SHA is only as good as the person who copied it.
- **Pinning is not review.** The code of these four actions was not read. It is now fixed instead of movable.
- **What a pinned action runs is not pinned by this.** An action can call other actions by tag, pull a container image or download a program. For `gitleaks-action` the marketplace page says the gitleaks version defaults to a hard-coded number inside the action, which the pinned release fixes; it does not say whether the download is verified, and that was not looked into. The others were not examined.
- **Local composite actions are not scanned.** Only `.github/workflows` is. There are none.
- **Other things CI fetches are covered elsewhere or not at all.** The sandbox test image is pinned by digest and gVisor by release and checksum ([ADR 0018](0018-gvisor-driver.md)). The base image of `infrastructure/docker/Dockerfile.api` is a tag and is still to do, as is a vulnerability scan of the image with a scanner that is itself pinned and checked. Node comes from `.nvmrc` and pnpm from the repository's own setting, and neither is checked by hash.
- **Nothing renews the pins on a schedule** until Renovate is installed.
- **The repository setting that limits which actions may run is not set** by this change, and cannot be from here.

## Evidence so far

- Run against the workflows as they were, the check reported all nine references (`actions/checkout` four times, `pnpm/action-setup` and `actions/setup-node` twice each, `gitleaks/gitleaks-action` once) as not pinned, and after the change it reports none.
- On 2026-11-12, with database tests required, `pnpm verify` passed locally: build, typecheck, lint, format check, the pin check with its 74 tests (none skipped), 894 tests (8 event schemas, 25 configuration, 17 logging, 143 storage, 83 auth, 27 migrate, 102 jobs, 97 ingestion, 100 API, 40 worker and 252 sandbox manager) and the smoke test. A check of every relative link in the docs (295, none broken) and the dependency audit (no known vulnerabilities) also passed. **49 tests were skipped locally**: the real-runtime sandbox file, because the engineering session has no Docker daemon. They run in CI.
- The tests cover each form of pinned reference that is accepted (plain, double and single quoted, quoted key, with and without a version comment, a path inside an action, a reusable workflow, a local action, an image with a full digest) and each that is refused: a tag, a branch, `latest`, a short, long, upper-case or non-hexadecimal SHA, no version, a SHA only in the comment or in the wrong place, an image with no digest or a wrong one, and every form the check cannot read (braces, the value on another line, an empty or block value, an anchor, an alias, a quote that is not closed, or a value that starts with any character YAML uses for something else). They also cover Windows and old Mac line endings with the right line numbers, text that only mentions `uses`, a directory with no workflow, one that does not exist, the file and line named in the output with the exit code, the default directory, and this repository's own workflows.
- Forty-one deliberate breakages of the check were made one at a time, each of which would let something unpinned through or refuse something pinned: the length, case and anchors of the two patterns, each form of the key, each way a value can be written, the handling of comments, line endings and line numbers, the rule for local files and images, the empty directory, the file filter, the file name in the output, each exit code, and the default directory. 36 were caught the first time and 5 survived. One of those changed nothing (an exit code set and then overwritten). The other four (the anchors of the digest pattern, and values that start with a character YAML reserves) got tests and were then caught. It was a manual run and is not automated. It did not cover the CI step or the pinned SHAs themselves, which were compared with the upstream tags by hand.
- Writing the tests found two defects in the first version of the check, both fixed: an unclosed quote was accepted as a plain value, and a file with Windows line endings had every `uses:` line skipped, so the check passed on a file it had not read.
