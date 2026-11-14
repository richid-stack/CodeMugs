import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PolicyInput } from "../fixtures.js";
import { validateRunRequest } from "../request.js";
import { createGvisorDriver } from "./driver.js";
import { containersOf, limitedPolicy, runtimes, type Runtime } from "./integration.support.js";
import { FIRST_RUN_ID, LAST_RUN_ID } from "./run-user.js";

/**
 * These run real containers, so they need a docker daemon and an image that is already on the host,
 * pinned by digest (`CODEMUGS_TEST_SANDBOX_IMAGE`). Without them they are skipped, and never
 * reported as passed. CI sets REQUIRE_DOCKER_TESTS=true, which turns "no daemon" or "no image"
 * into a failure. The gVisor half also needs the `runsc` runtime registered with the daemon, and
 * REQUIRE_GVISOR_TESTS=true does the same for it. They show what the daemon does with the
 * arguments: what the code inside can and cannot do, as seen from inside, and that nothing is left
 * behind. The same tests run for each driver, and what differs between them is written down in
 * `Flavour`, from what was observed (ADR 0018).
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** What is the same for every driver is written once below. What differs is written here. */
interface Flavour extends Runtime {
  /** True when the code inside runs on the host's kernel. */
  readonly sharesHostKernel: boolean;
  /** What the shell says when a write is refused on a read-only mount. */
  readonly readOnlyMessage: string;
  /** Docker's seccomp profile is applied to the program only when the kernel is the host's. */
  readonly seccompInProgram: boolean;
  /** Device nodes that must not exist. gVisor makes a `/dev/fuse` of its own, which is not the host's. */
  readonly devices: string;
  /**
   * The process limit for the fork test, and what the fork loop may reach. The limit counts every
   * task of the sandbox: under gVisor that includes gVisor's own, so far fewer programs fit in it.
   */
  readonly fork: { readonly limit: number; readonly atMost: number; readonly atLeast: number };
}

const flavours: readonly Flavour[] = [
  {
    ...runtimes[0],
    sharesHostKernel: true,
    readOnlyMessage: "Read-only file system",
    seccompInProgram: true,
    devices: "/dev/mem /dev/kvm /dev/sda /dev/fuse",
    fork: { limit: 32, atMost: 32, atLeast: 8 },
  },
  {
    ...runtimes[1],
    sharesHostKernel: false,
    readOnlyMessage: "Permission denied",
    seccompInProgram: false,
    devices: "/dev/mem /dev/kvm /dev/sda",
    fork: { limit: 128, atMost: 128, atLeast: 4 },
  },
];

for (const flavour of flavours) {
  const suite = flavour.usable || flavour.required ? describe : describe.skip;

  suite(`the ${flavour.name} driver, against a real docker daemon`, () => {
    let base: string;
    let work: string;
    let source: string;
    const driver = () => flavour.create({ workspaceRoot: work });

    beforeAll(async () => {
      if (!flavour.usable) {
        throw new Error(
          `the ${flavour.name} tests are required but there is no usable docker daemon${
            flavour.name === "gvisor" ? " with the runsc runtime" : ""
          }, or the image CODEMUGS_TEST_SANDBOX_IMAGE is not on this host`,
        );
      }
      base = await realpath(await mkdtemp(join(tmpdir(), "sandbox-it-")));
      work = join(base, "work");
      source = join(work, "src");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "hello.txt"), "hello from the source\n");
    });

    afterEach(async () => {
      // Whatever a test did, no container of ours may be left.
      if (!flavour.usable) return;
      expect(await containersOf(base)).toEqual([]);
    });

    afterAll(async () => {
      if (base !== undefined) await rm(base, { recursive: true, force: true });
    });

    async function execute(command: string[], change?: (policy: PolicyInput) => void) {
      const request = validateRunRequest(
        { policy: limitedPolicy(change), command, sourceDirectory: source },
        { workspaceRoot: work },
      );
      return driver().run(request);
    }

    const sh = (script: string, change?: (policy: PolicyInput) => void) =>
      execute(["sh", "-c", script], change);

    describe("what the code inside is", () => {
      it("is available, and says what it is", async () => {
        expect(await driver().availability()).toEqual({ available: true });
        expect(driver().name).toBe(flavour.name);
        expect(driver().isolation).toBe(flavour.isolation);
      });

      it(
        flavour.sharesHostKernel
          ? "runs on the kernel of the host"
          : "runs on a kernel of its own, which is not the host's",
        async () => {
          const result = await sh("uname -r; cat /proc/version");
          const [inside = "", version = ""] = result.stdout.split("\n");
          if (flavour.sharesHostKernel) {
            expect(inside).toBe(release());
          } else {
            expect(inside).not.toBe(release());
            expect(version).toMatch(/gvisor/i);
          }
        },
      );

      it("runs as a user of its own that owns nothing and is in no other group, in a directory it can write", async () => {
        const result = await sh(
          "id -u; id -g; id -G; pwd; touch /scratch/mine; stat -c '%u:%g' /scratch /scratch/mine",
        );
        expect(result).toMatchObject({ outcome: "exited", exitCode: 0, stderr: "" });
        const [uid, gid, groups, directory, scratch, file] = result.stdout.trimEnd().split("\n");
        expect(Number(uid)).toBeGreaterThanOrEqual(FIRST_RUN_ID);
        expect(Number(uid)).toBeLessThanOrEqual(LAST_RUN_ID);
        expect(gid).toBe(uid);
        // No supplementary group: not root's, and not any group of the image.
        expect(groups).toBe(gid);
        expect(directory).toBe("/scratch");
        // The scratch space, and what is made in it, belong to that user and no other.
        expect(scratch).toBe(`${uid}:${gid}`);
        expect(file).toBe(`${uid}:${gid}`);
      });

      it("has no capabilities and cannot gain any", async () => {
        const result = await sh(
          "grep -E '^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):' /proc/self/status",
        );
        const lines = Object.fromEntries(
          result.stdout
            .trim()
            .split("\n")
            .map((line) => line.split(/:\s+/) as [string, string]),
        );
        for (const set of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
          expect(lines[set]).toBe("0000000000000000");
        }
        expect(lines["NoNewPrivs"]).toBe("1");
        // Docker's profile filters what the program asks of the host's kernel. Under gVisor the
        // program asks gVisor, whose own filter is on its process on the host, so what the program
        // sees here is not the profile's mode (it was 0 when this was written).
        if (flavour.seccompInProgram) expect(lines["Seccomp"]).toBe("2");
      });

      it("sees only its own processes and no devices of the host", async () => {
        const result = await sh(
          `ls /proc | grep -c '^[0-9]'; for d in ${flavour.devices}; do test -e $d && echo present:$d; done; true`,
        );
        expect(Number(result.stdout.split("\n")[0])).toBeLessThanOrEqual(4);
        expect(result.stdout).not.toContain("present:");
      });

      it("has no way to reach the docker daemon", async () => {
        const result = await sh(
          "test -e /var/run/docker.sock; echo $?; test -e /run/docker.sock; echo $?",
        );
        expect(result.stdout).toBe("1\n1\n");
      });

      it("gets nothing from the environment of the program that started it", async () => {
        process.env["CODEMUGS_MARKER_SECRET"] = "must-not-reach-the-sandbox";
        try {
          const result = await execute(["env"]);
          expect(result.stdout).not.toContain("CODEMUGS_MARKER_SECRET");
          expect(result.stdout).not.toContain("must-not-reach-the-sandbox");
        } finally {
          delete process.env["CODEMUGS_MARKER_SECRET"];
        }
      });

      it("has its input closed", async () => {
        const result = await execute(["cat"]);
        expect(result).toMatchObject({ outcome: "exited", exitCode: 0, stdout: "" });
      });

      it("gets the command as it was written, and never through a shell", async () => {
        const result = await execute(["echo", "a; id", "$(id)", "--privileged", "$HOME"]);
        expect(result.stdout).toBe("a; id $(id) --privileged $HOME\n");
      });

      it("has few open files allowed and no core files", async () => {
        const result = await sh("ulimit -n; ulimit -c");
        expect(result.stdout).toBe("1024\n0\n");
      });
    });

    describe("what it can write", () => {
      it("cannot write to the root filesystem", async () => {
        const result = await sh(
          'touch /probe 2>&1; echo status=$?; awk \'$5 == "/" { print "mount:" $6 }\' /proc/self/mountinfo',
        );
        expect(result.stdout).toContain(flavour.readOnlyMessage);
        expect(result.stdout).toContain("status=1");
        expect(result.stdout).toMatch(/mount:ro[,\n]/);
      });

      it("can write to the scratch space, but cannot run a program from it", async () => {
        const result = await sh(
          "echo hi > /scratch/f && cat /scratch/f && cp /bin/true /scratch/t && /scratch/t 2>&1; echo status=$?",
        );
        expect(result.stdout).toContain("hi\n");
        expect(result.stdout).toContain("Permission denied");
        expect(result.stdout).toContain("status=126");
      });

      it("cannot write more to the scratch space than the policy gives", async () => {
        const result = await sh(
          "dd if=/dev/zero of=/scratch/big bs=1M count=64 2>&1; echo status=$?",
          (p) => {
            p.mounts.scratch.sizeMb = 8;
          },
        );
        expect(result.stdout).toContain("No space left on device");
        expect(result.stdout).not.toContain("status=0");
      });

      it("sees the source and cannot change it", async () => {
        // The shell reports a failed redirection itself, so the whole group is redirected.
        const result = await sh(
          'cat /workspace/hello.txt; { echo x > /workspace/new; } 2>&1; echo status=$?; { echo x >> /workspace/hello.txt; } 2>&1; echo status=$?; awk \'$5 == "/workspace" { print "mount:" $6 }\' /proc/self/mountinfo',
        );
        expect(result.stdout).toMatch(/^hello from the source\n/);
        expect(result.stdout.match(/status=1/g)).toHaveLength(2);
        expect(result.stdout).toMatch(/mount:ro[,\n]/);
        await expect(readFile(join(source, "new"))).rejects.toThrow();
        expect(await readFile(join(source, "hello.txt"), "utf8")).toBe("hello from the source\n");
      });
    });

    describe("what it can reach", () => {
      it("has no network other than its own loopback", async () => {
        // /proc/net/dev lists the interfaces for both runtimes; /sys/class/net does not exist in gVisor.
        const result = await sh(
          "awk -F: 'NR > 2 { gsub(/ /, \"\", $1); print $1 }' /proc/net/dev; echo ---; wget -q -T 3 -O /dev/null http://1.1.1.1/ 2>&1; echo status=$?",
        );
        expect(result.stdout.split("---")[0]).toBe("lo\n");
        expect(result.stdout).not.toContain("status=0");
      });
    });

    describe("limits", () => {
      it("holds a fork bomb to the number of processes the policy gives", async () => {
        // The shell of the image stops when a fork fails. It says which attempt it was about to make
        // before each one, so the last number is the attempt that failed.
        const result = await sh(
          "i=0; while [ $i -lt 600 ]; do i=$((i+1)); echo started=$i; sleep 20 & done",
          (p) => {
            p.limits.pids = flavour.fork.limit;
          },
        );
        expect(result.outcome).toBe("exited");
        const attempts = [...result.stdout.matchAll(/started=(\d+)/g)].map((match) =>
          Number(match[1]),
        );
        const failed = attempts.at(-1) ?? 0;
        expect(failed).toBeLessThan(600);
        expect(failed).toBeLessThanOrEqual(flavour.fork.atMost);
        expect(failed).toBeGreaterThan(flavour.fork.atLeast);
      });

      it("stops a program that uses more memory than the policy gives", async () => {
        const result = await sh("x=$(head -c 200000000 /dev/zero | tr '\\0' a); echo done", (p) => {
          p.limits.memoryMb = 64;
          p.limits.wallClockSeconds = 90;
        });
        expect(result.outcome).toBe("out_of_memory");
        expect(result.exitCode).toBeNull();
        expect(result.stdout).not.toContain("done");
      });

      it("stops a program that runs for too long, and removes it", async () => {
        const started = Date.now();
        const result = await execute(["sleep", "120"], (p) => {
          p.limits.wallClockSeconds = 2;
        });
        expect(result).toMatchObject({ outcome: "timed_out", exitCode: null });
        expect(Date.now() - started).toBeLessThan(20_000);
      });

      it("stops a program that prints without end, and keeps only what the policy allows", async () => {
        const result = await execute(["yes"], (p) => {
          p.limits.outputBytes = 10_000;
        });
        expect(result.outcome).toBe("output_limit_exceeded");
        expect(Buffer.byteLength(result.stdout)).toBe(10_000);
        expect(result.stdoutTruncated).toBe(true);
      });

      it("lets a program that was not stopped end with the exit code it chose", async () => {
        const result = await sh("echo before; echo problem >&2; exit 7");
        expect(result).toMatchObject({
          outcome: "exited",
          exitCode: 7,
          stdout: "before\n",
          stderr: "problem\n",
        });
      });
    });

    describe("runs that overlap", () => {
      it("each have a user of their own", async () => {
        // They sleep so that all of them are running while any of them is: one of them finishing
        // before another starts could not show a shared user.
        const results = await Promise.all([1, 2, 3, 4].map(() => sh("sleep 2; id -u")));
        const users = results.map((result) => result.stdout.trim());
        expect(results.every((result) => result.exitCode === 0)).toBe(true);
        expect(new Set(users).size).toBe(4);
        for (const user of users) {
          expect(Number(user)).toBeGreaterThanOrEqual(FIRST_RUN_ID);
          expect(Number(user)).toBeLessThanOrEqual(LAST_RUN_ID);
        }
      });

      it("do not see each other, and each is removed", async () => {
        const results = await Promise.all(
          [1, 2, 3, 4].map((n) =>
            sh(`echo run-${n}; echo ${n} > /scratch/mine; cat /scratch/mine`),
          ),
        );
        expect(results.map((result) => result.stdout)).toEqual([
          "run-1\n1\n",
          "run-2\n2\n",
          "run-3\n3\n",
          "run-4\n4\n",
        ]);
      });
    });

    describe("what cannot be started", () => {
      const notStarted = {
        name: "SandboxError",
        code: "start_failed",
        message: "the sandbox could not be started",
      };

      it("is refused, with a fixed sentence, when the image is not on the host", async () => {
        const missing = `docker.io/library/not-here@sha256:${"0".repeat(64)}`;
        const request = validateRunRequest(
          {
            policy: { ...limitedPolicy(), image: missing },
            command: ["true"],
            sourceDirectory: source,
          },
          { workspaceRoot: work },
        );
        await expect(driver().run(request)).rejects.toMatchObject(notStarted);
      });

      it("is refused, without a word of what docker said, when the program is not there", async () => {
        const error = await execute(["no-such-program-here"]).catch((caught: unknown) => caught);
        expect(error).toMatchObject(notStarted);
        expect(JSON.stringify(error)).not.toContain("no-such-program-here");
      });

      it("is unavailable when the daemon cannot be reached", async () => {
        const unreachable = flavour.create({
          workspaceRoot: work,
          environment: {
            PATH: process.env["PATH"] ?? "",
            DOCKER_HOST: "unix:///nonexistent/docker.sock",
          },
        });
        expect(await unreachable.availability()).toEqual({
          available: false,
          reason: "the docker daemon did not answer",
        });
        const request = validateRunRequest(
          { policy: limitedPolicy(), command: ["true"], sourceDirectory: source },
          { workspaceRoot: work },
        );
        await expect(unreachable.run(request)).rejects.toMatchObject({ code: "unavailable" });
      });
    });
  });
}

const gvisor = flavours.find((flavour) => flavour.name === "gvisor");
const gvisorSuite =
  gvisor !== undefined && (gvisor.usable || gvisor.required) ? describe : describe.skip;

gvisorSuite("what only gVisor does", () => {
  let base: string;
  let work: string;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "sandbox-gv-")));
    work = join(base, "work");
    await mkdir(work, { recursive: true });
  });

  afterEach(async () => {
    expect(await containersOf(base)).toEqual([]);
  });

  afterAll(async () => {
    if (base !== undefined) await rm(base, { recursive: true, force: true });
  });

  it("does not run at all when the process limit is too small for its own sandbox", async () => {
    // The limit counts the tasks of gVisor's sandbox too. Too small a limit stops it from starting,
    // and that is reported as not started, never as a run without the limit.
    const request = validateRunRequest(
      {
        policy: limitedPolicy((p) => {
          p.limits.pids = 8;
          delete p.mounts.source;
        }),
        command: ["echo", "must not run"],
      },
      { workspaceRoot: work },
    );
    const error = await createGvisorDriver({ workspaceRoot: work })
      .run(request)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "SandboxError", code: "start_failed" });
    expect(JSON.stringify(error)).not.toContain("must not run");
  });
});
