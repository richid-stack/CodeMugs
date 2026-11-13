# 0020. Escape and abuse tests on both runtimes: written from what was observed, with what got through written down

- **Status:** Accepted
- **Date:** 2026-11-13

## Context

[ADR 0007](0007-build-the-sandbox-early.md) says the sandbox is built early and that release gate 8 (code execution is isolated) needs escape and resource-abuse tests. [ADR 0017](0017-hardened-container-driver.md) and [ADR 0018](0018-gvisor-driver.md) built two drivers and tested that the restrictions take effect. Neither tried to get out, and ADR 0018 says so.

The restrictions were written from what the documentation says a runtime does. Before writing tests of escape and abuse, we looked at what the two runtimes do, on the machine the tests run on, with the options the driver uses. Tests written from a guess would have been tests of the guess.

## Decision

1. **Look first, then write the tests.** A temporary workflow ran four rounds on a GitHub-hosted runner (kernel 7.0.0-1019-azure, Docker 29.4.2, gVisor release 20261109.0, the pinned alpine image), under both runtimes, with the options the driver uses. Round 1 was broad (mounts, devices, namespaces, kernel files, cgroups, links in the source, what the program can learn, the network, host processes, limits). Round 2 added the program of escape attempts below and the abuse cases. Rounds 3 and 4 followed up what the first two found (the writable places and the resolver, then limits shared between runs). The workflow is in the history of the pull request and is not in the tree. It ran on the pushes of one branch, never on `main`, and it was removed before the merge.
2. **A program tries 47 attempts that real container escapes have used, and every one is written down as refused or accepted.** `engineering/sandbox-manager/test-programs/escape-probe.c` is built static by the test, so it runs on any image, and it runs inside each sandbox. Each attempt is made in a child process of its own, with arguments that do nothing harmful if the call gets through, and prints `<name> denied <ERRNO>` or `<name> reachable <ERRNO>`. The attempts: new user, mount, network, PID, IPC and UTS namespaces; mounting and re-mounting, from inside a user namespace as well; `chroot`, `pivot_root`, `fsopen`, `setns`, `open_by_handle_at`; `bpf`, `perf_event_open`, `userfaultfd`, `keyctl`, `io_uring_setup`; loading a module, `reboot`, `swapon`, the clock, the host name, the kernel log, `ioperm`, process accounting; device nodes and the files of the kernel (`/dev/mem`, `/dev/kmsg`, `/proc/kcore`, the cgroup files, `/proc/sys`, `sysrq`); `setuid`, `setgroups`, ambient capabilities; packet, algorithm, audit and vsock sockets. A call counts as refused when it fails for who is asking or because it is not there. It counts as reached when it gets past that, even if it then fails on its arguments.
3. **The test names what is allowed through, and fails when that list is wrong in either direction.** Every attempt not on the list must be refused. An attempt on the list that is refused now fails the test too, so the list cannot go stale and a new runtime release that changes a result is looked at. The number of attempts is asserted, and the program must print `done`, so a crash in the program is not read as every attempt having been refused.
4. **The tests hold the abuse behaviours that were observed.** Writable places, memory counting, host shared memory, links in the source, a crash, non-text output, a fork bomb (below).
5. **Three changes to the driver came out of it:**
   - _The text that a run returns is never more than `outputBytes` bytes._ The limit was on bytes and the result was text, and a byte that is not text becomes U+FFFD, three bytes. A program that wrote bytes that are not text got back up to three times the limit. The text is now cut again at a whole character, and is reported as cut.
   - _`/tmp` is an empty, read-only memory filesystem that cannot run programs, under every runtime._ gVisor gave the program a writable, executable `/tmp` that no option of ours had asked for. The path is reserved in the policy, so no mount can be put on it.
   - _Shared memory is 64 MB, written on the command._ Both runtimes already gave 64 MB (observed). It is now stated, so that a change of default is not a change of the limit.
6. **The tests need `gcc`.** `ubuntu-latest` has it. Where `REQUIRE_DOCKER_TESTS` or `REQUIRE_GVISOR_TESTS` is set (CI), a missing compiler fails the run. Elsewhere the tests that need it are skipped, as the other container tests are where there is no daemon.
7. **"No container of ours is left" is asked of a test's own workspace, not of the daemon.** The first CI run of these tests failed 29 tests because two test files run at the same time against the same daemon, and each saw the other's containers. The check now looks only at containers that mount a directory under its own workspace.

## What was observed

On the runner above. Where "not observed" appears, nothing was looked at; it is not a claim that it works.

### The 47 attempts

| Runtime            | Refused | Let through                                                                                                                                                                                                                                                          |
| ------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hardened container | 46      | `socket_netlink_audit`: a socket to the kernel's audit log can be made. Sending to it needs a capability that is dropped, and there is no network.                                                                                                                   |
| gVisor             | 44      | `unshare_user_namespace` and `user_namespace_then_mount_tmpfs`: gVisor allows user namespaces. They are gVisor's own. The two attempts to make the source or the root writable from inside one are refused. `read_kernel_log`: it is the log of gVisor's own kernel. |

How a refusal looks differs. The hardened container mostly answers `EPERM` (from the seccomp profile and the missing capabilities) and `EACCES` or a read-only error for files. gVisor answers `ENOSYS` for calls it does not implement (`userfaultfd`, `keyctl`, `io_uring_setup`), `EAFNOSUPPORT` for socket families it does not have, `EOPNOTSUPP` for `open_by_handle_at` and no file at all for most of `/proc` and `/sys` that the kernel would show. In the second round two attempts under gVisor were reported as reached that are refusals: `perf_event_open` answered `ENODEV` (there is no such device), and the audit socket answered with an error the program did not name. The program now counts `ENODEV` and "protocol not supported" as refusals. The tests pass with the audit socket off the list for gVisor, which is how it is known that the second was "protocol not supported": nothing else the program counts would have made it pass.

These are attempts at the doors, not exploits. A door that is closed says nothing about a flaw in what is behind it: the kernel under the hardened container, gVisor itself, or the host's daemon.

### Writable places

| Place             | Hardened container, as first observed | gVisor, as first observed            | Both, now                                  |
| ----------------- | ------------------------------------- | ------------------------------------ | ------------------------------------------ |
| The scratch space | writable (memory, the policy's size)  | the same                             | the same                                   |
| `/dev/shm`        | writable, 64 MB                       | writable, 64 MB                      | the same, stated                           |
| `/dev/mqueue`     | writable                              | not writable                         | writable under the hardened container only |
| `/tmp`            | read-only                             | **writable, and could run programs** | read-only, empty, `noexec`                 |
| everything else   | read-only                             | read-only                            | the same                                   |

Everything writable is memory. Nothing a program writes reaches the host's disk, and all of it counts against the memory limit. The test lists the writable places for each runtime, so a new one fails it.

### Abuse

- **Memory.** 60 MB into shared memory and 15 MB into the scratch space, in a sandbox of 64 MB, is an out-of-memory stop under both runtimes. A flood of small files in the scratch space ended the run with exit 137 under both. Under the hardened container the kernel may kill a child and leave the shell running (exit 0, `OOMKilled` true in Docker's record), so the driver reports `out_of_memory` from Docker's record, not from the exit code.
- **Processes.** A loop that starts processes stops at the limit under both runtimes (the existing tests). A real fork bomb (`b() { b | b & }`) is contained under the hardened container and the program went on. Under gVisor the sandbox ended with exit 2 when the limit was reached, instead of the fork failing for the program. The test asserts what matters for the host: the run ends, nothing is left, and the next run works.
- **Output.** As above.
- **A crash.** A segmentation fault ends the program with status 139 under both. The core file limit is 0 and nothing is left in the scratch space.
- **IPC.** `--ipc=private` holds: objects made on the host are not listed in the sandbox, and a file made in the host's `/dev/shm` is not there.
- **Links in the source.** Absolute links to a file of the host, relative links out of the source, `..`, `/` and `/proc/1/root` are all read inside the sandbox, where the host's paths are not. A link to `/etc/hostname` reads the sandbox's own.
- **Host processes.** `kill` of a process of the host, or of `-1`, finds no such process, and the host process went on.
- **The network.** Only the loopback exists. The address of the host, the bridge, the internet and the host's resolver are all unreachable.
- **The processor.** `--cpus` slows a loop under both runtimes (a loop that took 0.6 s with one processor took about 3 s with 0.2). It is not tested, because a test of time is a test of the runner's load.

### What a program can learn about the host (not closed)

- **Under the hardened container,** `/proc/cpuinfo`, `/proc/meminfo` (the host's memory, not the limit), `/proc/version` (the host's kernel) and `/proc/sys/kernel/core_pattern` can be read. The last is a pipe to the host's core-dump handler. The container has no user namespace of its own (it is in the host's), so uid 65534 inside is the host's `nobody`.
- **Under gVisor** the same files show gVisor's own values: its kernel version, and the memory limit as the memory.
- **Under both,** `/etc/resolv.conf` is the host's: the address of its resolver and its cloud search domain, written by Docker even with no network. `--dns=127.0.0.1` replaces the address and keeps the search domain.

### The limits that runs share under the hardened container (not closed)

Three runs at once, each starting 50 `inotify` instances, on a host that allows 128 per user: the three together got 128, and 6, 3 and 13 of the 50 failed with "No file descriptors available". Alone, one run got all 60 that it asked for. All runs use the same user id (65534), and the kernel counts several limits per user, not per container. One run can use up what every other run, and every other process of that user on the host, can have. The process limit does not do this, since Docker's `--pids-limit` is per container. The three runs under gVisor printed nothing in the probe, so it is not known whether it is the same there.

## Rejected alternatives

- **Asserting that every attempt is refused.** It is false for both runtimes, and the right response to a true result is to write it down with the reason, not to hide it or to bend the program until it passes.
- **Writing the tests before looking.** See the context.
- **Real exploits.** They would be tests of one flaw in one version, they would be a stock of attack code in the repository, and they are not needed to learn whether a door is closed.
- **Disabling user namespaces in gVisor, or masking the files of the host, now.** No evidence yet that they open a way out. Each is a change with its own tests, and gVisor's flags were left at their defaults in ADR 0018 on purpose.
- **Testing the processor limit by time.** It would fail on a busy runner and prove nothing when it did not.
- **Serialising the test files instead of scoping the leftover check.** It hides the coupling and breaks the next time a file is added to the package.

## Not decided, or not done

- **Release gate 8 stays not started.** These tests show that two runtimes refuse a list of calls and hold a few kinds of abuse on one runner. They do not show that a sandbox is enough for hostile code, and nothing may claim that they do.
- **The user id is shared by all runs.** Each run should have its own, so that the per-user limits of the kernel are not shared and one run cannot starve the others. This is the next pull request, with the `inotify` case above as its regression test. The scratch space is owned by the same id and has to follow it.
- **A crash under the hardened container may start the host's core handler.** The kernel passes a crash to the handler in `core_pattern` even when the core file limit is 0 (reasoned from how the kernel handles a piped pattern; not observed here). What the handler does with it was not looked at.
- **gVisor ends the sandbox at the process limit** and the driver reports it as an exit with code 2. Whether a caller should be told it was the limit is not decided.
- **The host details that a program can read** (the resolver, the kernel, `core_pattern`) are not closed. Closing them is a decision for the driver, and some of it (a resolver file of our own) is a change to what a sandbox mounts.
- **gVisor's user namespaces** are allowed. A program inside one is still refused every mount that matters, but it is more of gVisor's code reached from inside the sandbox.
- **No microVM driver exists.** Whether one is needed is for the owner and for gate 8, and after the next pull request.
- **One runner, one image, two releases.** A different host, kernel or gVisor platform may behave differently. The list of what gets through fails when a release changes it, which is the reason it is checked in rather than reasoned.
- **The renewal of the pinned gVisor release, the image and the runner's versions** is by hand, and each renewal re-reads this list.
