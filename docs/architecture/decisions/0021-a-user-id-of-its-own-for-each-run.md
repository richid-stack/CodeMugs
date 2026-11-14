# 0021. A user and group id of its own for each run, because the kernel counts some limits per user

- **Status:** Accepted
- **Date:** 2026-11-14

## Context

[ADR 0020](0020-escape-and-abuse-tests.md) found that runs under the hardened container share limits that the kernel counts for each user and not for each container. Three runs at once, each starting 50 `inotify` instances, on a host that allows 128 per user, got 128 between them, and some of the instances failed with "No file descriptors available". Every run was user 65534, and the container has no user namespace of its own, so the ids inside are the host's. One run could use up what every other run, and every other process of that user on the host, was allowed to have. The process limit does not do this: Docker's `--pids-limit` is for the container.

That is a way for one run to starve the others, and the runs are the code of different customers. It is not an escape, and it is not the only thing that is counted per user, so closing it for `inotify` is not the claim. The claim is that no two runs are the same user to the kernel, whatever it counts.

## Decision

1. **Each run draws a user id and a group id of its own, and the two are the same number.** The id is drawn from 1 900 000 000 to 2 099 999 999, both ends included, with `crypto.randomInt`. It is used for `--user` and for the owner of the scratch space (`uid=` and `gid=` on its `--tmpfs`), which has to follow it, or the program could not write there (ADR 0017 decision 3). No other id is on the command line.
2. **The range is chosen so that it is not the id of anyone on the host.** It is above every range that systemd documents for users (system users, dynamic service users, home directory users, and containers, which end at 1 879 048 191), and below 2^31, because some code reads an id as signed and systemd's documentation names the kernel's `devpts` as one. The range is written out in a test, so that changing it is a visible change.
3. **The argument builder takes the user as a parameter, and the driver draws it.** `dockerCreateArguments` stays a pure function that a test can check, and refuses a user outside the range (root and nobody are outside it, and so is a number that is not whole) with a sentence that names no id. The driver draws a user for each run, in one place.
4. **A collision is allowed, and is not a hole.** Two runs that draw the same id are the same user, as every run was before this decision, and their processes, memory and files are still their own. With 100 runs at once the chance that any two match is about one in 40 000 (100 × 99 / 2 pairs, over 200 million ids). Nothing keeps a list of the ids in use, because a list in one process says nothing about the other processes and hosts that start runs.
5. **The test is the case that was observed.** Three runs at once, each starting a little over half of the host's `inotify` instances per user (`floor(limit / 2) + 1`, so 65 on a host with 128), which is more than the host gives one user between them and less than it gives one. It reads the limit from the host and is skipped, with the reason, where the host allows so many that programs limited to 1024 open files cannot use them up. Three more tests say the property that matters on every host: the user is in the range and the group is the same number, with no other group, and the scratch space and a file made in it belong to that user; four runs that overlap each have a different user; and the argument builder and the driver are checked without a daemon.

## Consequences

- **What was run, and what it showed.** The test was committed alone first and run in CI on the code as it was. Under the hardened container the three runs got 31 and 36 failures out of 65 for two of them, and none for the third. With each run's own id, the same test passed under both runtimes in CI: all three runs started all 65 and none failed. Under gVisor the same test did not get as far as its point: in the run before the change the three runs printed nothing (the reason was not recorded), and in the run with the change they ended with exit code 2 after about a second, which is how a process limit that is too small for gVisor's own tasks ends a sandbox (ADR 0020), and the test passed when its limit was raised from 105 to 1 000. That is the evidence for the cause: no run read it out of the sandbox. So **it is not known whether gVisor shared the limit before the change**. The test now asks for a larger process limit, and passes under gVisor.
- **gVisor accepted the ids.** The tests that read the user, the group and the owner of the scratch space passed under gVisor as well, with ids over a billion.
- **The user has no entry in the image's `/etc/passwd`.** The id is a number that no image knows. `id` prints it, and the tests read it that way. A program that looks up the name, or the home directory, of its user gets no answer from the image. Nothing in the tests depends on it, and no program that does was tried.
- **The source is read as "other".** The prepared source is a read-only bind mount owned by someone on the host, and the run's user is neither its owner nor in its group. What the program can read of it is what the permission bits give to everyone (reasoned from how the kernel checks access, as it was for user 65534; not a new test). The code that prepares the source, when there is some, has to leave the files readable by everyone.
- **A host with a user-namespace mapping is not tried.** If the daemon maps container ids (`userns-remap`), ids outside what it maps would stop the run from starting (`start_failed`), not make it run less safely. No test covers that setup.
- **Release gate 8 stays not started.** This closes one way for runs to affect each other, found by ADR 0020's probe. It is not evidence that a sandbox is enough for hostile code, and nothing may say that it is.

## Rejected alternatives

- **Keeping 65534 and limiting what is counted per user in some other way.** The inotify limits are sysctls of the host, and as far as is known Docker has no setting for them for one container (not tried). Raising the host's sysctls would hide the case on one host and leave the sharing.
- **A user namespace for each run.** It would also separate the counts, but Docker's remapping is a setting of the whole daemon and not of a run, and it changes how the source mount and the scratch space are owned. It was not tried.
- **A counter for the ids.** The next number is easy to guess, and two processes that start runs on one host would both start at the same number and collide at once instead of by chance.
- **A list of ids in use.** See decision 4.
- **Reading the user from the request.** A request holds a policy, a command and a source, and the user is not something a caller chooses (invariant 4: nothing grants itself permission).

## Not decided, or not done

- **Other things that are shared between runs on one host are not looked at beyond this one.** The page cache, the clock, the host's disk and network stack for a daemon's own traffic, and the load on the host's processors are all shared, and the isolation tests do not measure them.
- **Whether a host where the user ids are mapped, or where users of the host fall in this range (for instance from a directory service), needs a configured range.** It is a constant today.
- **The items that ADR 0020 left open** (the core handler on the host under the hardened container, gVisor ending the sandbox at the process limit with exit 2, the host details a program can read, gVisor's user namespaces) are unchanged, and so is the question of a microVM driver.
