# @codemugs/sandbox-manager

Isolated execution environments for customer code and for anything built from it. Customer code never runs outside this module, including repository analysis ([ADR 0007](../../docs/architecture/decisions/0007-build-the-sandbox-early.md)).

**Status:** Phase 1 · Foundation (started). What exists is the **policy model**, the **driver interface** and **one driver: a hardened container run by the `docker` command**. It is the weakest isolation level, because the container shares the host's kernel, so it is **not enough for hostile third-party code** ([ADR 0007](../../docs/architecture/decisions/0007-build-the-sandbox-early.md) decision 5). Nothing in this repository may claim that code execution is isolated: release gate 8 (escape and resource-abuse tests, and a stronger driver) is not started. Nothing calls the driver yet. Next: a gVisor driver and the first escape tests ([roadmap](../../docs/engineering/roadmap.md), step 5). Decisions: [ADR 0016](../../docs/architecture/decisions/0016-sandbox-policy-and-driver-interface.md) (policy and interface), [ADR 0017](../../docs/architecture/decisions/0017-hardened-container-driver.md) (the driver).

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

## The Docker driver

```ts
import { createDockerDriver, validateRunRequest } from "@codemugs/sandbox-manager";

const driver = createDockerDriver({ workspaceRoot: "/var/lib/codemugs/work" });
if ((await driver.availability()).available) {
  const request = validateRunRequest(
    { policy, command: ["node", "analyse.js"], sourceDirectory },
    { workspaceRoot },
  );
  const result = await driver.run(request); // or throws SandboxError
}
```

It drives the `docker` command (no library, no shell: every argument is a separate item). A run is `docker create`, `docker start --attach`, `docker inspect`, `docker rm --force --volumes`, and the container is removed whatever happened. What the container gets, all written out on `docker create` so that no default of the daemon decides anything that matters:

- no network, no shared IPC, a read-only root filesystem, no capabilities and no way to gain any, the user `65534:65534`, and Docker's default seccomp profile;
- the policy's memory (with swap set to the same value), processes and processors, and fixed limits on open files and core files; the daemon keeps none of the output;
- one writable place, the scratch space: in memory, the policy's size, owned by the unprivileged user and no one else, and unable to hold programs to run;
- the source directory, if the request has one, as a read-only bind mount, after its symbolic links were resolved and it was checked again to be a directory inside the workspace;
- the command as an argument list: the first item is the entrypoint, so the image's own entrypoint never runs, and no item can become an option of docker;
- no environment variables from this process, and no image pulling: the image has to be on the host already.

The result says how the run ended (`exited`, `timed_out`, `output_limit_exceeded` or `out_of_memory`). The wall-clock limit and the output limit are enforced by this process, which kills the container; when both apply the first one found is reported. A failure is a `SandboxError` with a fixed sentence (`unavailable`, `source_not_allowed`, `start_failed`, `run_failed` or `cleanup_failed`), never anything docker or the program said. A container that cannot be removed outranks every other result.

## Tests

```bash
pnpm --filter @codemugs/sandbox-manager test
```

- **Without Docker** (what runs locally): the policy and request rules from both sides (accepted at the edge, refused just past it), the frozen copies, the brand on a checked request, what a refusal says, the exact arguments of `docker create` (with hostile values in every position), and the driver's logic against a stand-in `docker` command: the order of the calls, limits, outcomes, cleanup and what is reported.
- **Against a real Docker daemon** (`src/docker/docker.integration.test.ts`): what the hardening does in practice. It needs `CODEMUGS_TEST_SANDBOX_IMAGE`, an image pinned by digest that is already on the host, and a daemon, and is skipped when either is missing. CI sets both and sets `REQUIRE_DOCKER_TESTS=true`, which turns a missing daemon or image into a failure. To run it locally: `docker pull <image>`, then set `CODEMUGS_TEST_SANDBOX_IMAGE` to the same reference. The image CI uses is in `.github/workflows/ci.yml`.

## Not done

- **One driver, and the weakest level.** gVisor and then a microVM are not written. The container shares the host's kernel and the Docker daemon runs as root, so the host that runs this driver is part of the trust boundary ([ADR 0017](../../docs/architecture/decisions/0017-hardened-container-driver.md)).
- **No test suite that every driver has to pass.** The real-Docker tests are specific to this driver. They become the shared suite when the second driver exists.
- **No escape tests** (release gate 8). The real-Docker tests show that the hardening takes effect (user, capabilities, no network, read-only filesystems, limits, cleanup). They are not attempts to break out.
- **No reaper.** If the process dies between `create` and `rm`, a container is left. It carries the label `codemugs.sandbox=true`, and nothing removes it.
- **No network allow-list, no credentials**, and so no way yet for an agent runtime to reach a model API from inside a sandbox. They come with the enforcement.
- **Nothing produces policies.** The policy engine does not exist yet, so invariant 4 (a policy is produced by the policy engine and never by an agent) is a rule of the design, not something enforced in code. The ceilings are the second line.
- **The source directory is resolved and then mounted, not mounted from a handle.** Between the two steps something that can write inside the workspace could replace a directory with a link. The manager owns the workspace, and that is all that prevents it.
- **An image that declares a `VOLUME` gets a writable volume from the daemon**, outside the scratch space and not limited in size. It is removed with the container. Images are chosen by the policy engine, which does not exist yet.
- The ceilings and the floors are first values and have not been measured.
