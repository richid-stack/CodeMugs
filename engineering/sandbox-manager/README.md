# @codemugs/sandbox-manager

Isolated execution environments for customer code and for anything built from it. Customer code never runs outside this module, including repository analysis ([ADR 0007](../../docs/architecture/decisions/0007-build-the-sandbox-early.md)).

**Status:** Phase 1 · Foundation (started). What exists is the **policy model** and the **driver interface**, with tests that need no container runtime. **There is no driver yet, so nothing runs in a sandbox, and nothing in this repository may claim isolation** (release gate 8 is not started). The first driver (a hardened container) and the first escape and resource-abuse tests are the next steps ([roadmap](../../docs/engineering/roadmap.md), step 5). Decision: [ADR 0016](../../docs/architecture/decisions/0016-sandbox-policy-and-driver-interface.md).

## What it provides

```ts
import {
  parseSandboxPolicy,
  validateRunRequest,
  assertValidatedRequest,
  isolationAtLeast,
  type SandboxDriver,
} from "@codemugs/sandbox-manager";
```

- `parseSandboxPolicy(input)` checks a policy and returns a **frozen copy**, or throws `SandboxRequestError`.
- `validateRunRequest(input, { workspaceRoot })` checks a whole run (policy, command, source directory) and returns a frozen `SandboxRunRequest`. Only this function makes one.
- `assertValidatedRequest(request)` is what a driver calls first: it throws for a request that did not come from `validateRunRequest`, even if it was cast to the type or is a copy of a checked one.
- `SandboxDriver` is the interface a driver implements: `name`, `isolation` (`hardened-container`, `gvisor` or `microvm`), `availability()` and `run(request)`. `SandboxResult` says how the run ended (`exited`, `timed_out`, `output_limit_exceeded` or `out_of_memory`), the exit code, and what the program printed, cut at the policy's limit. `SandboxError` has a code and a fixed sentence.
- `isolationAtLeast(actual, required)` orders the levels, so a caller that needs more than a hardened container (hosted tier, third-party code, [ADR 0007](../../docs/architecture/decisions/0007-build-the-sandbox-early.md) decision 5) can refuse a weaker driver.

## The policy

Deny by default: **every value is required and nothing has a default**, unknown fields are refused at every level, and every limit has a floor (so that `0` never means "no limit") and a ceiling (`SANDBOX_CEILINGS`, first values that have not been measured).

```ts
{
  image: "ghcr.io/example/analyser@sha256:<64 hex digits>", // pinned by digest, never a tag
  limits: { cpus: 1, memoryMb: 512, pids: 128, wallClockSeconds: 60, outputBytes: 1_048_576 },
  mounts: {
    source: { containerPath: "/workspace" },  // read-only, optional; the host directory comes with the request
    scratch: { containerPath: "/scratch", sizeMb: 64 }, // writable, in memory, gone at the end of the run
  },
  network: { mode: "none" },                  // the only mode there is
}
```

There is deliberately **no field** for what no driver can enforce yet or what must not be granted: no network access (so no allow-list), no credentials, no writable source, no environment variables, no devices, no extra privileges. A policy that has one is refused. Adding one is a decision of its own, with the enforcement and the tests that go with it.

Paths use a small alphabet (`A-Z a-z 0-9 . _ -`), because a comma, colon, equals sign or space has a meaning in a runtime's mount syntax and a path that held one could add an option to the mount. The source directory on the host has to be inside the folder the manager keeps its working copies in (`workspaceRoot`).

A refusal names the fields and the reason, never the values or the names of fields it did not recognise.

## Tests

```bash
pnpm --filter @codemugs/sandbox-manager test
```

They need nothing but Node. They cover each rule above from both sides (accepted at the edge, refused just past it), the frozen copies, the brand on a checked request, and what a refusal says.

## Not done

- **No driver.** The hardened container driver, then gVisor, then a microVM; and a test suite that every driver has to pass.
- **No escape or resource-abuse tests** (release gate 8).
- **No network allow-list, no credentials**, and so no way yet for an agent runtime to reach a model API from inside a sandbox. They come with the enforcement.
- **Nothing produces policies.** The policy engine does not exist yet, so invariant 4 (a policy is produced by the policy engine and never by an agent) is a rule of the design, not something enforced in code. The ceilings are the second line.
- **The source directory is checked as written.** A driver must also resolve symbolic links before it mounts anything, and that belongs to the driver.
- The ceilings and the floors are first values and have not been measured.
