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
5. **Hardened containers alone are not enough for hostile third-party code.** Containers share the host kernel, so a kernel escape reaches the host. A hardened container is acceptable for development, our own code and first-party code such as OpenLobs. Before the hosted service runs a third-party customer's code, a stronger driver must pass the escape and resource-abuse tests that close release gate 8.
6. **Agent runtimes run inside the sandbox** (ADR 0003). Their credentials, network and filesystem are whatever the policy grants, nothing more.

## Consequences

- Phases 1 and 2 grow. Phase 5 shrinks to orchestration, reviews and pull requests, plus the isolation proof.
- Every analysis run pays a start-up cost. Measure it before optimising; reusing warm sandboxes across tenants is not allowed.
- Egress control matters as much as process isolation. Default-deny network is part of the first driver, not a later hardening step.
- Driver tests need a container runtime. Policy construction and validation are unit-tested everywhere. Driver integration tests need Docker, run in CI, and must be reported as skipped, never as passed, where no daemon is available.
- Nothing in the documentation or the product may claim isolation until the gate 8 evidence exists.

## Alternatives considered

- **Keep the sandbox in Phase 5 and make Phase 2 static-only.** Cheaper now, but it relies on discipline, and verification cannot run tests until Phase 5.
- **Build the full strong-isolation stack (microVMs) before anything else.** Strongest, but it spends months on infrastructure before the central idea is proven. The driver interface lets us start hardened and strengthen.
- **Use a third-party sandbox service only.** Fast to adopt, but it puts customer source code with another sub-processor and ties a trust boundary to a vendor. Kept as an optional driver, not the foundation.

## Revisit when

The Phase 2 driver spike shows a hardened container with gVisor is too weak or too slow for the hosted tier, or a managed service passes our escape tests with acceptable data terms.
