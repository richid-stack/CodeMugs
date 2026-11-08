# 0007. Build the sandbox early, as a foundation

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

The first plan put the sandbox in Phase 5, after repository analysis (Phase 2) and the intelligence engine. That ordering leaves a rule that is easy to break under pressure: "we will not run customer code until the sandbox exists". It also leaves two real needs unmet earlier:

- **Analysis.** Customer repositories are untrusted input. Parsers are attack surface, and anything beyond pure parsing (resolving dependencies, running a build or a test suite) is code execution.
- **Verification.** A change is only verified when its tests actually run (invariant 5). That needs somewhere safe to run them.

Isolation added after code paths already exist is how escapes and credential leaks get built in. The owner decided the sandbox should be a foundation, not a late feature.

## Decision

1. **The sandbox is a Phase 1 and 2 foundation.** Phase 1 delivers the policy model and the driver interface. Phase 2 delivers the first working driver, used by repository analysis. Phase 5 keeps agent orchestration and the proof that the isolation holds (release gate 8).
2. **One rule, no exceptions.** Customer code, and anything built from it, is never executed outside a sandbox. That includes repository analysis: parsers and analysers also run inside the sandbox, using an analysis profile (read-only source, no network, no credentials, resource limits). This replaces the earlier "restricted worker" idea in gap 12.
3. **A sandbox run is described by a typed, deny-by-default policy**: image pinned by digest, CPU, memory, process count, disk and wall-clock limits, filesystem mounts (source read-only, scratch writable), network egress allow-list (default none), credentials (default none, otherwise scoped and temporary), and output size caps. The policy is produced by the policy engine, never by an agent (invariant 4).
4. **Drivers sit behind one interface** (`engineering/sandbox-manager`), so the isolation technology can change without touching callers:
   - First driver: a hardened container. Non-root, read-only root filesystem, all capabilities dropped, no privilege escalation, default seccomp profile, no host mounts and no container runtime socket, network disabled unless the policy allows it.
   - Evaluated in Phase 2: gVisor as the container runtime, and a microVM (Firecracker or Kata Containers) for the hosted multi-tenant tier. A managed sandbox service can be a driver too if it passes the same tests and its data handling is acceptable.
5. **Hardened containers alone are not enough for hostile third-party code.** Containers share the host kernel, so a kernel escape reaches the host. A hardened container is acceptable for development, our own code and other first-party code we control. Before the hosted service runs a third-party customer's code, a stronger driver must pass the escape and resource-abuse tests that close release gate 8.
6. **Agent runtimes run inside the sandbox** (ADR 0003). Their credentials, network and filesystem are whatever the policy grants, nothing more.

## Consequences

- Phases 1 and 2 grow. Phase 5 shrinks to orchestration, reviews and pull requests, plus the isolation proof.
- Every analysis run pays a start-up cost. Measure it before optimising; reusing warm sandboxes across tenants is not allowed.
- Egress control matters as much as process isolation. Default-deny network is part of the first driver, not a later hardening step.
- Driver tests need a container runtime. Policy construction and validation are unit-tested everywhere. Driver integration tests need Docker, run in CI, and must be reported as skipped, never as passed, where no daemon is available.
- Nothing in the documentation or the product may claim isolation until the gate 8 evidence exists.

## Evidence so far

A throwaway probe ran three times on 2026-11-07 on a GitHub-hosted runner (standard `ubuntu-latest`: Ubuntu 26.04.1, 2 vCPU, about 8 GB, Docker 29.4.2) in this private repository on the free plan.

| Check                                                                                                         | Result                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Hardened container: non-root, read-only root filesystem, no capabilities, no network, process and memory caps | Passed. uid 65534, empty capability sets, writes to `/` refused, no network                                                          |
| gVisor (`runsc` release-20261102.0) from its signed apt repository, registered as a Docker runtime            | Worked. A container under it reported gVisor's own kernel (`4.19.0-gvisor`), and the full set of hardened flags also worked under it |
| KVM, which microVMs such as Firecracker and Kata need                                                         | `/dev/kvm` was present in all three runs, and a test virtual machine could be created through it (KVM API version 12)                |

What this shows and does not show:

- These isolation layers can be exercised in CI without paying for infrastructure, so driver integration tests can run there. The engineering session's own environment has no container daemon and no KVM, so CI is the test environment.
- It does **not** show the isolation is strong. No escape or resource-abuse test has run (release gate 8 is still not started), and no microVM has been booted yet. Only a KVM virtual machine was created.
- It is one runner type on one date. I found no official statement guaranteeing KVM on GitHub-hosted runners, so treat it as something to re-check, not to rely on. Re-run the probe if the repository's visibility or plan changes.
- The first two attempts failed because the gVisor download path I used from memory had changed. The install steps came from the current install guide. Real driver tests must pin the image by digest and the gVisor version.

Next: boot a Firecracker microVM in CI, write the first escape and resource-abuse tests, and pin versions.

## Alternatives considered

- **Keep the sandbox in Phase 5 and make Phase 2 static-only.** Cheaper now, but it relies on discipline, and verification cannot run tests until Phase 5.
- **Build the full strong-isolation stack (microVMs) before anything else.** Strongest, but it spends months on infrastructure before the central idea is proven. The driver interface lets us start hardened and strengthen.
- **Use a third-party sandbox service only.** Fast to adopt, but it puts customer source code with another sub-processor and ties a trust boundary to a vendor. Kept as an optional driver, not the foundation.

## Revisit when

The Phase 2 driver spike shows a hardened container with gVisor is too weak or too slow for the hosted tier, or a managed service passes our escape tests with acceptable data terms.
