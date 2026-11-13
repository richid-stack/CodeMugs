# @codemugs/sandbox-manager

Isolated execution environments for customer code and for anything built from it. Customer code never runs outside this module, including repository analysis ([ADR 0007](../../docs/architecture/decisions/0007-build-the-sandbox-early.md)).

**Status:** Phase 1 · Foundation (started). What exists is the **policy model**, the **driver interface** and **two drivers, both run by the `docker` command: a hardened container, and the same container under gVisor**. The hardened container is the weakest level, because it shares the host's kernel, and is **not enough for hostile third-party code** ([ADR 0007](../../docs/architecture/decisions/0007-build-the-sandbox-early.md) decision 5). Escape and resource-abuse tests run against both drivers in CI ([ADR 0020](../../docs/architecture/decisions/0020-escape-and-abuse-tests.md)). They show what two runtimes refuse on one runner, not that a sandbox is enough, so nothing in this repository may claim that code execution is isolated, and release gate 8 is not started. Nothing calls a driver yet. Next: a user id of its own for each run ([roadmap](../../docs/engineering/roadmap.md), step 5). Decisions: [ADR 0016](../../docs/architecture/decisions/0016-sandbox-policy-and-driver-interface.md) (policy and interface), [ADR 0017](../../docs/architecture/decisions/0017-hardened-container-driver.md) (the hardened container), [ADR 0018](../../docs/architecture/decisions/0018-gvisor-driver.md) (gVisor), [ADR 0020](../../docs/architecture/decisions/0020-escape-and-abuse-tests.md) (escape and abuse tests).

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
- the writable places, all in memory and all counted against the memory limit: the scratch space (the policy's size, owned by the unprivileged user and no one else, unable to hold programs to run), shared memory (64 MB) and, under the hardened container, a message-queue directory. `/tmp` is an empty read-only filesystem that cannot run programs. A test lists the writable places for each runtime;
- the source directory, if the request has one, as a read-only bind mount, after its symbolic links were resolved and it was checked again to be a directory inside the workspace;
- the command as an argument list: the first item is the entrypoint, so the image's own entrypoint never runs, and no item can become an option of docker;
- no environment variables from this process, and no image pulling: the image has to be on the host already.

### gVisor

```ts
import { createGvisorDriver } from "@codemugs/sandbox-manager";

const driver = createGvisorDriver({ workspaceRoot: "/var/lib/codemugs/work" });
```

The same driver with one more option, `--runtime=runsc`: everything above applies unchanged, and the program's system calls are answered by gVisor's kernel in user space instead of the host's. Its isolation level is `gvisor`. It needs a runtime called `runsc` registered with the Docker daemon (`runsc install`), and is _unavailable_ without one: it never falls back to the default runtime. Things that differ from the hardened container, as observed (ADR 0018 has the table): the program sees another kernel (`4.19.0-gvisor`), `Seccomp` reads 0 inside, a refused write says "Permission denied", and **the process limit counts gVisor's own tasks**, so a limit that is fine for the hardened container can be too small for gVisor to start (such a run is `start_failed`). The policy engine, once there, has to choose limits per driver.

A container that could not be started (a program that is not in the image, a sandbox that could not be made) is `start_failed` for both drivers, read from docker's own record of the reason, and nothing docker printed is kept.

The result says how the run ended (`exited`, `timed_out`, `output_limit_exceeded` or `out_of_memory`). The wall-clock limit and the output limit are enforced by this process, which kills the container; when both apply the first one found is reported. A failure is a `SandboxError` with a fixed sentence (`unavailable`, `source_not_allowed`, `start_failed`, `run_failed` or `cleanup_failed`), never anything docker or the program said. A container that cannot be removed outranks every other result.

## Tests

```bash
pnpm --filter @codemugs/sandbox-manager test
```

- **Without Docker** (what runs locally): the policy and request rules from both sides (accepted at the edge, refused just past it), the frozen copies, the brand on a checked request, what a refusal says, the exact arguments of `docker create` (with hostile values in every position), and the driver's logic against a stand-in `docker` command: the order of the calls, limits, outcomes, cleanup and what is reported.
- **Against a real Docker daemon** (`src/docker/docker.integration.test.ts`): what the hardening does in practice, for each driver (the same 24 tests, with the differences between the drivers written down in one table, plus one that only gVisor has). It needs `CODEMUGS_TEST_SANDBOX_IMAGE`, an image pinned by digest that is already on the host, and a daemon, and the gVisor half also needs the `runsc` runtime. Each half is skipped when what it needs is missing. CI provides everything and sets `REQUIRE_DOCKER_TESTS=true` and `REQUIRE_GVISOR_TESTS=true`, which turn a missing daemon, image or runtime into a failure. To run it locally: `docker pull <image>`, then set `CODEMUGS_TEST_SANDBOX_IMAGE` to the same reference (and install gVisor and run `runsc install` for the second half). The image and the gVisor release CI uses are pinned in `.github/workflows/ci.yml`.

## Not done

- **No microVM driver, and the hardened container is the weakest level.** It shares the host's kernel, and the Docker daemon runs as root, so the host that runs these drivers is part of the trust boundary ([ADR 0017](../../docs/architecture/decisions/0017-hardened-container-driver.md)). gVisor is not a virtual machine either, and it is only run in CI so far ([ADR 0018](../../docs/architecture/decisions/0018-gvisor-driver.md)).
- **The escape tests are not proof** (release gate 8). They try 47 calls and files that real escapes have used and a few kinds of abuse, on one runner, and write down what each runtime lets through. They do not look for a flaw in the kernel, in gVisor or in the daemon. Findings that are not closed (a user id shared by all runs, details of the host that a program can read, a core handler on the host under the hardened container) are in ADR 0020.
- **gVisor's performance, compatibility and platform are not measured or recorded** (ADR 0018).
- **No reaper.** If the process dies between `create` and `rm`, a container is left. It carries the label `codemugs.sandbox=true`, and nothing removes it.
- **No network allow-list, no credentials**, and so no way yet for an agent runtime to reach a model API from inside a sandbox. They come with the enforcement.
- **Nothing produces policies.** The policy engine does not exist yet, so invariant 4 (a policy is produced by the policy engine and never by an agent) is a rule of the design, not something enforced in code. The ceilings are the second line.
- **The source directory is resolved and then mounted, not mounted from a handle.** Between the two steps something that can write inside the workspace could replace a directory with a link. The manager owns the workspace, and that is all that prevents it.
- **An image that declares a `VOLUME` gets a writable volume from the daemon**, outside the scratch space and not limited in size. It is removed with the container. Images are chosen by the policy engine, which does not exist yet.
- The ceilings and the floors are first values and have not been measured.
