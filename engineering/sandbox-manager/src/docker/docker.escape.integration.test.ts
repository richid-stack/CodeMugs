import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mustRun, runtimes, useWorkspace, type Runtime } from "./integration.support.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * What escape attempts and resource abuse do against each real runtime (ADR 0020). It runs real
 * containers, so it is skipped where there is no daemon, and fails in CI, where there must be one.
 * These are tests of what was observed on a hosted runner, not proof that a sandbox is enough for
 * hostile code: release gate 8 stays open (docs/operations/release-gates.md).
 */
const run = promisify(execFile);
const probe = fileURLToPath(new URL("../../test-programs/escape-probe.c", import.meta.url));
const compiler = await run("gcc", ["--version"]).then(
  () => true,
  () => false,
);

/** How many attempts the program makes. A change to the program changes this, on purpose. */
const ATTEMPTS = 47;

/**
 * The attempts that got through, under each runtime, and why that is accepted for now. Every other
 * attempt must be refused. A runtime that starts letting one more through fails the test, and so
 * does one that stops letting one through, so the list cannot go stale.
 */
const reachable: Record<Runtime["name"], readonly string[]> = {
  // Creating a socket for the kernel's audit log works. Sending to it needs a capability that is
  // dropped, and the container has no network, so nothing leaves.
  docker: ["socket_netlink_audit"],
  gvisor: [
    // gVisor allows user namespaces. They are its own, so they reach no host kernel code, and the
    // two attempts to make the source or the root writable from inside one are refused.
    "unshare_user_namespace",
    "user_namespace_then_mount_tmpfs",
    // It is the log of gVisor's own kernel, not the host's.
    "read_kernel_log",
  ],
};

/** The places a program can write, other than the scratch space. The policy gives it these. */
const writable: Record<Runtime["name"], readonly string[]> = {
  // runc mounts a message queue directory that is writable (ADR 0020).
  docker: ["/dev/mqueue", "/dev/shm", "/scratch"],
  gvisor: ["/dev/shm", "/scratch"],
};

for (const runtime of runtimes) {
  const suite = mustRun(runtime) ? describe : describe.skip;

  suite(`the ${runtime.name} driver, against escape attempts and abuse`, () => {
    const ws = useWorkspace(runtime, `codemugs-escape-${runtime.name}`);

    describe("the program of escape attempts", () => {
      beforeAll(async () => {
        if (!compiler) {
          if (runtime.required)
            throw new Error("the escape attempts are required but gcc is not here");
          return;
        }
        await run("gcc", ["-static", "-O1", "-o", join(ws.source(), "escape-probe"), probe]);
      });

      it.skipIf(!compiler && !runtime.required)(
        "is refused every attempt except the ones that are written down",
        async () => {
          const result = await ws.execute(["/workspace/escape-probe"]);
          expect(result).toMatchObject({ outcome: "exited", exitCode: 0, stdoutTruncated: false });
          const lines = result.stdout.trimEnd().split("\n");
          // It says it came to the end, so that an attempt that crashed the program is not read as
          // all the attempts having been refused.
          expect(lines.at(-1)).toBe("done");
          const attempts = lines.slice(0, -1).map((line) => {
            const match = /^([a-z_]+) (denied|reachable) (\S+)$/.exec(line);
            expect(match, line).not.toBeNull();
            return { name: match?.[1] ?? "", verdict: match?.[2] ?? "", errno: match?.[3] ?? "" };
          });
          expect(new Set(attempts.map((attempt) => attempt.name)).size).toBe(ATTEMPTS);
          expect(attempts).toHaveLength(ATTEMPTS);
          const through = attempts
            .filter((attempt) => attempt.verdict === "reachable")
            .map((attempt) => attempt.name)
            .sort();
          expect(through).toEqual([...reachable[runtime.name]].sort());
        },
      );
    });

    it("can write only to the scratch space and to shared memory", async () => {
      const places =
        "/ /dev /dev/shm /dev/mqueue /dev/pts /tmp /run /var/tmp /etc /root /home /proc /sys /workspace /scratch";
      const result = await ws.sh(
        `for d in ${places}; do if touch "$d/.probe" 2>/dev/null; then echo "$d"; fi; done`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().split("\n").sort()).toEqual([...writable[runtime.name]]);
    });

    it("counts what it keeps in shared memory and in the scratch space against its memory", async () => {
      // 75 MB of files, all of them memory, in a sandbox that has 64. The second program replaces
      // the shell, so that it is the one the kernel stops, and the run ends by SIGKILL.
      const result = await ws.sh(
        "dd if=/dev/zero of=/dev/shm/a bs=1M count=60 2>/dev/null; exec dd if=/dev/zero of=/scratch/b bs=1M count=15 2>/dev/null",
        (policy) => {
          policy.limits.memoryMb = 64;
          policy.limits.wallClockSeconds = 90;
        },
      );
      expect(result.outcome).toBe("out_of_memory");
    });

    it("does not see the shared memory of the host", async () => {
      const marker = `codemugs-host-marker-${randomUUID()}`;
      const hostFile = join("/dev/shm", marker);
      await writeFile(hostFile, "on the host");
      try {
        const result = await ws.sh(`ls -A /dev/shm; test -e "/dev/shm/${marker}" || echo absent`);
        expect(result.stdout).not.toContain(marker);
        expect(result.stdout.trim().split("\n").at(-1)).toBe("absent");
      } finally {
        await rm(hostFile, { force: true });
      }
    });

    it("cannot reach a file of the host through a link in the source", async () => {
      // The links are made by the program that prepared the source, so a run must not follow them to
      // the host: they are read inside the sandbox, where the host's paths are not.
      const secret = `secret-${randomUUID()}`;
      const hostDirectory = dirname(ws.source());
      const outside = join(hostDirectory, "outside-marker");
      await writeFile(outside, secret);
      await symlink(outside, join(ws.source(), "absolute"));
      await symlink("../outside-marker", join(ws.source(), "relative"));
      await symlink("..", join(ws.source(), "up"));
      await symlink("/", join(ws.source(), "root"));
      await symlink("/proc/1/root", join(ws.source(), "pid-one-root"));
      const paths = [
        "/workspace/absolute",
        "/workspace/relative",
        "/workspace/up/outside-marker",
        "/workspace/root/outside-marker",
        "/workspace/pid-one-root/outside-marker",
        outside,
      ];
      const result = await ws.sh(
        `for p in ${paths.map((p) => `"${p}"`).join(" ")}; do cat "$p" 2>&1; done; test -e "${hostDirectory}" || echo host-path-absent`,
      );
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      expect(result.stdout).toContain("host-path-absent");
    });

    it("leaves nothing in the scratch space when it crashes", async () => {
      // The core file limit is 0. Under runc the kernel's core handler is the host's, which this
      // does not change (ADR 0020), so what is checked is what is inside.
      const result = await ws.sh(
        "sh -c 'kill -SEGV $$'; echo status=$?; test -z \"$(ls -A /scratch)\" && echo scratch-empty",
      );
      expect(result).toMatchObject({ outcome: "exited", exitCode: 0 });
      expect(result.stdout).toBe("status=139\nscratch-empty\n");
    });

    it("returns no more than the limit when the output is bytes that are not text", async () => {
      // Each such byte becomes three bytes of text, so this was once three times the limit.
      const result = await ws.sh("head -c 3000000 /dev/urandom", (policy) => {
        policy.limits.outputBytes = 100_000;
      });
      expect(result.outcome).toBe("output_limit_exceeded");
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(100_000);
      expect(result.stdoutTruncated).toBe(true);
    });

    it("does not let runs at once use up what the kernel counts for each user", async (context) => {
      // The kernel limits some things per user, not per container, and the host's numbers apply
      // (ADR 0020, ADR 0021). Under runc, three runs of one user shared the limit on `inotify`
      // instances, and the ones that came last failed. Here the runs ask for more than the host
      // gives one user between them, and each for less than it gives one.
      const limit = Number(await readFile("/proc/sys/fs/inotify/max_user_instances", "utf8"));
      const each = Math.floor(limit / 2) + 1;
      if (!(each >= 2 && each <= 300)) {
        // A host that allows thousands cannot be run out of them by programs that may open 1024
        // files each. The user-id tests say the property that matters, and this one has no case.
        context.skip(`the host allows ${limit} inotify instances per user`);
      }
      const script = `for i in $(seq 1 ${each}); do inotifyd - /scratch:n >/dev/null 2>/scratch/err$i & done; sleep 6; echo "running=$(ps | grep -c '[i]notifyd') failed=$(cat /scratch/err* 2>/dev/null | grep -c .)"`;
      const runs = await Promise.all(
        [1, 2, 3].map(() =>
          ws.sh(script, (policy) => {
            policy.limits.pids = each + 40;
            policy.limits.memoryMb = 512;
            policy.limits.wallClockSeconds = 60;
          }),
        ),
      );
      expect(runs.map((result) => result.stdout)).toEqual(
        Array(3).fill(`running=${each} failed=0\n`),
      );
    });

    it("survives a fork bomb, and the next run is not harmed by it", async () => {
      const bomb = await ws.sh("b() { b | b & }; b; sleep 2; echo survived", (policy) => {
        policy.limits.wallClockSeconds = 30;
      });
      expect(["exited", "timed_out", "output_limit_exceeded"]).toContain(bomb.outcome);
      // afterEach checks that no container of ours is left. The next run says the host is fine.
      const next = await ws.sh("echo alive");
      expect(next).toMatchObject({ outcome: "exited", exitCode: 0, stdout: "alive\n" });
    });
  });
}
