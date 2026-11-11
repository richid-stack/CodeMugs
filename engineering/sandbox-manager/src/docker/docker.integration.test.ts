import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { validPolicyInput, type PolicyInput } from "../fixtures.js";
import { validateRunRequest } from "../request.js";
import { SANDBOX_LABEL } from "./arguments.js";
import { createDockerDriver } from "./driver.js";

/**
 * These run real containers, so they need a docker daemon and an image that is already on the host,
 * pinned by digest (`CODEMUGS_TEST_SANDBOX_IMAGE`). Without them they are skipped, and never
 * reported as passed. CI sets REQUIRE_DOCKER_TESTS=true, which turns "no daemon" or "no image"
 * into a failure. They show what the daemon does with the arguments: what the code inside can
 * and cannot do, as seen from inside, and that nothing is left behind.
 */
const run = promisify(execFile);
const image = process.env["CODEMUGS_TEST_SANDBOX_IMAGE"];
const required = process.env["REQUIRE_DOCKER_TESTS"] === "true";

async function docker(...args: string[]): Promise<string> {
  return (await run("docker", args)).stdout;
}

const imagePresent =
  image !== undefined &&
  (await docker("image", "inspect", "--format", "{{.Id}}", image).then(
    () => true,
    () => false,
  ));
const usable =
  imagePresent && (await createDockerDriver({ workspaceRoot: "/" }).availability()).available;
const suite = usable || required ? describe : describe.skip;

suite("the hardened container driver, against a real docker daemon", () => {
  let base: string;
  let work: string;
  let source: string;
  const driver = () => createDockerDriver({ workspaceRoot: work });

  beforeAll(async () => {
    if (!usable) {
      throw new Error(
        "REQUIRE_DOCKER_TESTS is set but there is no docker daemon or the image CODEMUGS_TEST_SANDBOX_IMAGE is not on this host",
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
    if (!usable) return;
    const left = await docker("ps", "-a", "-q", "--filter", `label=${SANDBOX_LABEL}`);
    expect(left.trim()).toBe("");
  });

  afterAll(async () => {
    if (base !== undefined) await rm(base, { recursive: true, force: true });
  });

  function policy(change: (policy: PolicyInput) => void = () => undefined): PolicyInput {
    const value = validPolicyInput();
    value.image = image ?? value.image;
    value.limits = {
      cpus: 1,
      memoryMb: 256,
      pids: 64,
      wallClockSeconds: 30,
      outputBytes: 1_048_576,
    };
    value.mounts.scratch.sizeMb = 16;
    change(value);
    return value;
  }

  async function execute(command: string[], change?: (policy: PolicyInput) => void) {
    const request = validateRunRequest(
      { policy: policy(change), command, sourceDirectory: source },
      { workspaceRoot: work },
    );
    return driver().run(request);
  }

  const sh = (script: string, change?: (policy: PolicyInput) => void) =>
    execute(["sh", "-c", script], change);

  describe("what the code inside is", () => {
    it("runs as a user that owns nothing, in a directory it can write", async () => {
      const result = await sh("id -u; id -g; pwd");
      expect(result).toMatchObject({ outcome: "exited", exitCode: 0 });
      expect(result.stdout).toBe("65534\n65534\n/scratch\n");
    });

    it("has no capabilities, cannot gain any, and is filtered by seccomp", async () => {
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
      expect(lines["Seccomp"]).toBe("2");
    });

    it("sees only its own processes and no devices of the host", async () => {
      const result = await sh(
        "ls /proc | grep -c '^[0-9]'; for d in /dev/mem /dev/kvm /dev/sda /dev/fuse; do test -e $d && echo present:$d; done; true",
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
      expect(result.stdout).toContain("Read-only file system");
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
      const result = await sh(
        "ls /sys/class/net; wget -q -T 3 -O /dev/null http://1.1.1.1/ 2>&1; echo status=$?",
      );
      expect(result.stdout.split("\n")[0]).toBe("lo");
      expect(result.stdout).not.toContain("status=0");
    });
  });

  describe("limits", () => {
    it("holds a fork bomb to the number of processes the policy gives", async () => {
      // The shell of the image stops when a fork fails. It says which attempt it was about to make
      // before each one, so the last number is the attempt that failed: the shell and every sleep
      // before it were running, and together they are what the limit allowed.
      const result = await sh(
        "i=0; while [ $i -lt 300 ]; do i=$((i+1)); echo started=$i; sleep 20 & done",
        (p) => {
          p.limits.pids = 32;
        },
      );
      expect(result.outcome).toBe("exited");
      const attempts = [...result.stdout.matchAll(/started=(\d+)/g)].map((match) =>
        Number(match[1]),
      );
      const failed = attempts.at(-1) ?? 0;
      expect(failed).toBeLessThan(300);
      expect(failed).toBeLessThanOrEqual(32);
      expect(failed).toBeGreaterThan(8);
    });

    it("stops a program that uses more memory than the policy gives", async () => {
      const result = await sh("x=$(head -c 200000000 /dev/zero | tr '\\0' a); echo done", (p) => {
        p.limits.memoryMb = 64;
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

    it("reports a program that cannot be found as the container runtime does", async () => {
      const result = await execute(["no-such-program-here"]);
      expect(result.outcome).toBe("exited");
      expect([126, 127]).toContain(result.exitCode);
    });
  });

  describe("runs that overlap", () => {
    it("do not see each other, and each is removed", async () => {
      const results = await Promise.all(
        [1, 2, 3, 4].map((n) => sh(`echo run-${n}; echo ${n} > /scratch/mine; cat /scratch/mine`)),
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
    it("is refused, with a fixed sentence, when the image is not on the host", async () => {
      const missing = `docker.io/library/not-here@sha256:${"0".repeat(64)}`;
      const request = validateRunRequest(
        {
          policy: { ...policy(), image: missing },
          command: ["true"],
          sourceDirectory: source,
        },
        { workspaceRoot: work },
      );
      await expect(driver().run(request)).rejects.toMatchObject({
        name: "SandboxError",
        code: "start_failed",
        message: "the sandbox could not be started",
      });
    });

    it("is unavailable when the daemon cannot be reached", async () => {
      const unreachable = createDockerDriver({
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
        { policy: policy(), command: ["true"], sourceDirectory: source },
        { workspaceRoot: work },
      );
      await expect(unreachable.run(request)).rejects.toMatchObject({ code: "unavailable" });
    });
  });

  it("is available, and is a hardened container", async () => {
    expect(await driver().availability()).toEqual({ available: true });
    expect(driver().isolation).toBe("hardened-container");
  });
});
