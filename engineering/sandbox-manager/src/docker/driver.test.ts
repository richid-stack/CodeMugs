import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isolationAtLeast, SandboxError } from "../driver.js";
import { validPolicyInput, type PolicyInput } from "../fixtures.js";
import { SandboxRequestError } from "../policy.js";
import { validateRunRequest, type SandboxRunRequest } from "../request.js";
import { createDockerDriver, createGvisorDriver, type DockerDriverOptions } from "./driver.js";
import { FIRST_RUN_ID, LAST_RUN_ID } from "./run-user.js";

/**
 * A stand-in for the docker command, so that what the driver does with processes (waiting, killing,
 * cutting output, cleaning up, what it reports) is tested without a daemon. What the real daemon
 * does with the arguments is tested in docker.integration.test.ts, where one is available.
 */
const FAKE = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, env: Object.keys(process.env) }) + "\\n");
const verb = args[0];
const named = args.find((a) => a.startsWith("--name="));
const name = named ? named.slice(7) : args.find((a) => a.startsWith("codemugs-sandbox-")) || "";
const killed = path.join(dir, "killed-" + name);
const out = (fd, text) => {
  let rest = Buffer.isBuffer(text) ? text : Buffer.from(text);
  while (rest.length > 0) {
    try { rest = rest.subarray(fs.writeSync(fd, rest)); } catch (e) { if (e.code !== "EAGAIN") throw e; }
  }
};
if (verb === "version") process.exit(cfg.version ?? 0);
else if (verb === "info") { out(1, cfg.info ?? "{}"); process.exit(cfg.infoExit ?? 0); }
else if (verb === "create") process.exit(cfg.create ?? 0);
else if (verb === "kill") {
  if (!cfg.killIgnored) fs.writeFileSync(killed, "");
  setTimeout(() => {
    fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args: ["kill-finished"], env: [] }) + "\\n");
    process.exit(cfg.kill ?? 0);
  }, cfg.killDelayMs ?? 0);
}
else if (verb === "rm") process.exit(cfg.rm ?? 0);
else if (verb === "inspect") {
  out(1, cfg.inspect ?? JSON.stringify({ Running: false, OOMKilled: false, ExitCode: cfg.exitCode ?? 0, Error: cfg.stateError ?? "" }));
  process.exit(cfg.inspectExit ?? 0);
} else if (verb === "start") {
  if (cfg.stdout) out(1, cfg.stdout.replace("{name}", name));
  if (cfg.stderr) out(2, cfg.stderr);
  if (cfg.stdoutBase64) out(1, Buffer.from(cfg.stdoutBase64, "base64"));
  if (cfg.stderrBase64) out(2, Buffer.from(cfg.stderrBase64, "base64"));
  for (let i = 0; i < (cfg.floodStdout ?? 0); i += 1000) out(1, "x".repeat(1000));
  for (let i = 0; i < (cfg.floodStderr ?? 0); i += 1000) out(2, "y".repeat(1000));
  if (cfg.hang) {
    setInterval(() => { if (fs.existsSync(killed)) process.exit(137); }, 20);
  } else process.exit(cfg.startExit ?? 0);
} else process.exit(2);
`;

interface Scenario {
  version?: number;
  create?: number;
  kill?: number;
  killIgnored?: boolean;
  killDelayMs?: number;
  rm?: number;
  inspect?: string;
  stateError?: string;
  info?: string;
  infoExit?: number;
  inspectExit?: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** Bytes, as base64, for output that is not text. */
  stdoutBase64?: string;
  stderrBase64?: string;
  floodStdout?: number;
  floodStderr?: number;
  hang?: boolean;
  startExit?: number;
}

interface Call {
  args: string[];
  env: string[];
}

const folders: string[] = [];

async function setup(scenario: Scenario = {}, options: Partial<DockerDriverOptions> = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "fake-docker-")));
  folders.push(base);
  const bin = join(base, "bin");
  const work = join(base, "work");
  const source = join(work, "src");
  await mkdir(bin);
  await mkdir(source, { recursive: true });
  await writeFile(join(bin, "docker"), FAKE, { mode: 0o755 });
  const configure = (next: Scenario) => writeFile(join(bin, "config.json"), JSON.stringify(next));
  await configure(scenario);
  const driver = createDockerDriver({
    workspaceRoot: work,
    dockerCommand: join(bin, "docker"),
    stopGraceMs: 300,
    ...options,
  });
  return {
    base,
    work,
    source,
    driver,
    configure,
    calls: async (): Promise<Call[]> => {
      try {
        const text = await readFile(join(bin, "calls.jsonl"), "utf8");
        return text
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as Call);
      } catch {
        return [];
      }
    },
    request(
      overrides: { policy?: PolicyInput; command?: string[]; sourceDirectory?: string } = {},
    ): SandboxRunRequest {
      return validateRunRequest(
        {
          policy: overrides.policy ?? validPolicyInput(),
          command: overrides.command ?? ["node", "analyse.js"],
          sourceDirectory: overrides.sourceDirectory ?? source,
        },
        { workspaceRoot: work },
      );
    },
  };
}

const verbs = (calls: Call[]) => calls.map((call) => call.args[0]);

function policyWith(limits: Partial<PolicyInput["limits"]>): PolicyInput {
  const policy = validPolicyInput();
  policy.limits = { ...policy.limits, ...limits };
  return policy;
}

afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

describe("what the driver is", () => {
  it("is a hardened container called docker", async () => {
    const { driver } = await setup();
    expect(driver.name).toBe("docker");
    expect(driver.isolation).toBe("hardened-container");
  });
});

describe("availability", () => {
  it("is available when the daemon answers", async () => {
    const { driver } = await setup({ version: 0 });
    expect(await driver.availability()).toEqual({ available: true });
  });

  it("is not available when the daemon does not answer, and says so without the daemon's words", async () => {
    const { driver } = await setup({ version: 1 });
    expect(await driver.availability()).toEqual({
      available: false,
      reason: "the docker daemon did not answer",
    });
  });

  it("runs the docker command it finds on its PATH when none is named", async () => {
    const t = await setup();
    const driver = createDockerDriver({
      workspaceRoot: t.work,
      environment: { PATH: join(t.base, "bin") },
    });
    expect(await driver.availability()).toEqual({ available: true });
    expect(verbs(await t.calls())).toEqual(["version"]);
  });

  it("is not available when there is no docker command", async () => {
    const { driver } = await setup({}, { dockerCommand: "/nonexistent/docker" });
    expect(await driver.availability()).toEqual({
      available: false,
      reason: "the docker command was not found",
    });
  });
});

describe("a run that ends by itself", () => {
  it("returns what the program printed and its exit code, and makes the calls in order", async () => {
    const t = await setup({ stdout: "hello\n", stderr: "warning\n", exitCode: 3 });
    const result = await t.driver.run(t.request());
    expect(result).toMatchObject({
      outcome: "exited",
      exitCode: 3,
      stdout: "hello\n",
      stderr: "warning\n",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const calls = await t.calls();
    expect(verbs(calls)).toEqual(["create", "start", "inspect", "rm"]);
    expect(calls[1]?.args.slice(0, 2)).toEqual(["start", "--attach"]);
    expect(calls[3]?.args.slice(0, 3)).toEqual(["rm", "--force", "--volumes"]);
  });

  it("uses one name for the container in every call, a different one for every run", async () => {
    const t = await setup();
    await t.driver.run(t.request());
    await t.driver.run(t.request());
    const calls = await t.calls();
    const names = calls.map((call) => {
      const named = call.args.find((arg) => arg.startsWith("--name="));
      return named === undefined ? call.args.at(-1) : named.slice(7);
    });
    expect(names.slice(0, 4)).toEqual(Array(4).fill(names[0]));
    expect(names.slice(4)).toEqual(Array(4).fill(names[4]));
    expect(names[0]).not.toBe(names[4]);
    expect(names[0]).toMatch(/^codemugs-sandbox-[0-9a-f-]{36}$/);
  });

  it("gives every run its own output when runs overlap", async () => {
    const t = await setup({ stdout: "{name}" });
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => t.driver.run(t.request())));
    const created = (await t.calls())
      .filter((call) => call.args[0] === "create")
      .map((call) => (call.args.find((arg) => arg.startsWith("--name=")) ?? "").slice(7));
    expect(new Set([a?.stdout, b?.stdout, c?.stdout]).size).toBe(3);
    expect(created.sort()).toEqual([a?.stdout, b?.stdout, c?.stdout].sort());
  });

  it("runs every run as a user of its own, the same in the user option and the scratch space", async () => {
    const t = await setup();
    await Promise.all([1, 2, 3, 4, 5, 6].map(() => t.driver.run(t.request())));
    const creates = (await t.calls()).filter((call) => call.args[0] === "create");
    expect(creates).toHaveLength(6);
    const users = creates.map((call) => {
      const user = call.args.find((arg) => arg.startsWith("--user=")) ?? "";
      const [uid, gid] = user.slice(7).split(":");
      const scratch = call.args.find((arg) => arg.startsWith("--tmpfs=/scratch")) ?? "";
      expect(scratch).toContain(`uid=${uid},gid=${gid}`);
      expect(gid).toBe(uid);
      expect(Number(uid)).toBeGreaterThanOrEqual(FIRST_RUN_ID);
      expect(Number(uid)).toBeLessThanOrEqual(LAST_RUN_ID);
      return uid;
    });
    // Six draws from two hundred million: a repeat means that the id is not drawn for each run.
    expect(new Set(users).size).toBe(6);
    expect(creates.flatMap((call) => call.args).join(" ")).not.toContain("65534");
  });

  it("passes the command to docker as separate arguments, never through a shell", async () => {
    const t = await setup();
    await t.driver.run(t.request({ command: ["sh", "-c", "echo hi; rm -rf /"] }));
    const create = (await t.calls())[0]?.args ?? [];
    expect(create.at(-1)).toBe("echo hi; rm -rf /");
    expect(create.at(-2)).toBe("-c");
    expect(create).toContain("--entrypoint=sh");
  });
});

/**
 * Runs `action` and says how many of the timers it started were never cleared. A timer left
 * behind keeps the process from ending for as long as the policy's time limit, and can fire for a
 * container that no longer exists.
 */
async function timersLeftBy(action: () => Promise<unknown>): Promise<number> {
  const started = vi.spyOn(globalThis, "setTimeout");
  const cleared = vi.spyOn(globalThis, "clearTimeout");
  try {
    await action();
    const done = new Set<unknown>(cleared.mock.calls.map(([handle]) => handle));
    return started.mock.results.filter((result) => !done.has(result.value)).length;
  } finally {
    started.mockRestore();
    cleared.mockRestore();
  }
}

describe("what a run leaves behind", () => {
  it("is no timer, after a run that ended by itself", async () => {
    const t = await setup({ stdout: "done" });
    const left = await timersLeftBy(async () => {
      expect((await t.driver.run(t.request())).outcome).toBe("exited");
    });
    expect(left).toBe(0);
  });

  it("is no timer, after a run that was stopped for printing too much", async () => {
    const t = await setup({ floodStdout: 200_000 }, { stopGraceMs: 60_000 });
    const left = await timersLeftBy(async () => {
      const result = await t.driver.run(t.request({ policy: policyWith({ outputBytes: 1_000 }) }));
      expect(result.outcome).toBe("output_limit_exceeded");
    });
    expect(left).toBe(0);
  });

  it("is no kill of a container that has already ended", async () => {
    const t = await setup({ stdout: "done" });
    await t.driver.run(t.request({ policy: policyWith({ wallClockSeconds: 1 }) }));
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(verbs(await t.calls())).toEqual(["create", "start", "inspect", "rm"]);
  });
});

describe("limits that are reached", () => {
  it("stops a run that takes too long, reports it as timed out, and removes the container", async () => {
    const t = await setup({ hang: true });
    const started = Date.now();
    const result = await t.driver.run(t.request({ policy: policyWith({ wallClockSeconds: 1 }) }));
    expect(result).toMatchObject({ outcome: "timed_out", exitCode: null });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(verbs(await t.calls())).toEqual([
      "create",
      "start",
      "kill",
      "kill-finished",
      "inspect",
      "rm",
    ]);
  });

  it("ends the docker client itself if the kill does not end it, and still cleans up", async () => {
    const t = await setup({ hang: true, kill: 1, killIgnored: true });
    const result = await t.driver.run(t.request({ policy: policyWith({ wallClockSeconds: 1 }) }));
    expect(result.outcome).toBe("timed_out");
    const calls = verbs(await t.calls());
    expect(calls.at(-1)).toBe("rm");
    expect(calls).toContain("kill");
  });

  it("stops a run that prints too much on standard output, and keeps only what the policy allows", async () => {
    const t = await setup({ floodStdout: 200_000 });
    const result = await t.driver.run(t.request({ policy: policyWith({ outputBytes: 1_000 }) }));
    expect(result.outcome).toBe("output_limit_exceeded");
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toHaveLength(1_000);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
    expect(verbs(await t.calls())).toEqual([
      "create",
      "start",
      "kill",
      "kill-finished",
      "inspect",
      "rm",
    ]);
  });

  it("waits for the kill to finish before it reads the state and removes the container", async () => {
    // The fake docker client ends at once here, while the kill is still going on.
    const t = await setup({ floodStdout: 200_000, killDelayMs: 400 });
    const result = await t.driver.run(t.request({ policy: policyWith({ outputBytes: 1_000 }) }));
    expect(result.outcome).toBe("output_limit_exceeded");
    expect(verbs(await t.calls())).toEqual([
      "create",
      "start",
      "kill",
      "kill-finished",
      "inspect",
      "rm",
    ]);
  });

  it("does the same for standard error", async () => {
    const t = await setup({ floodStderr: 200_000, stdout: "fine" });
    const result = await t.driver.run(t.request({ policy: policyWith({ outputBytes: 1_000 }) }));
    expect(result.outcome).toBe("output_limit_exceeded");
    expect(result.stderr).toHaveLength(1_000);
    expect(result.stderrTruncated).toBe(true);
    expect(result.stdout).toBe("fine");
    expect(result.stdoutTruncated).toBe(false);
  });

  it("counts each stream on its own: two streams each at the limit are not too much", async () => {
    const t = await setup({ stdout: "a".repeat(1_000), stderr: "b".repeat(1_000) });
    const result = await t.driver.run(t.request({ policy: policyWith({ outputBytes: 1_000 }) }));
    expect(result.outcome).toBe("exited");
    expect(result.stdout).toHaveLength(1_000);
    expect(result.stderr).toHaveLength(1_000);
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
    expect(verbs(await t.calls())).not.toContain("kill");
  });

  it("is over the limit by one byte", async () => {
    const t = await setup({ stdout: "a".repeat(1_001) });
    const result = await t.driver.run(t.request({ policy: policyWith({ outputBytes: 1_000 }) }));
    expect(result.outcome).toBe("output_limit_exceeded");
    expect(result.stdout).toHaveLength(1_000);
    expect(result.stdoutTruncated).toBe(true);
  });

  it("reports a program that the memory limit stopped", async () => {
    const t = await setup({
      inspect: JSON.stringify({ Running: false, OOMKilled: true, ExitCode: 137 }),
    });
    const result = await t.driver.run(t.request());
    expect(result).toMatchObject({ outcome: "out_of_memory", exitCode: null });
  });

  it("reports a program that ended by SIGKILL as stopped by the memory limit, when docker did not say so", async () => {
    // Docker does not always record an out-of-memory kill. The exit code is then all there is.
    const t = await setup({
      inspect: JSON.stringify({ Running: false, OOMKilled: false, ExitCode: 137 }),
    });
    const result = await t.driver.run(t.request());
    expect(result).toMatchObject({ outcome: "out_of_memory", exitCode: null });
  });

  it.each([0, 1, 136, 138, 143])(
    "reports exit code %i as the program's own exit",
    async (exitCode) => {
      const t = await setup({
        inspect: JSON.stringify({ Running: false, OOMKilled: false, ExitCode: exitCode }),
      });
      const result = await t.driver.run(t.request());
      expect(result).toMatchObject({ outcome: "exited", exitCode });
    },
  );

  it("reports the limit of ours that stopped a program, not the SIGKILL that it caused", async () => {
    // Stopping a container ends it by SIGKILL, so exit code 137 is what a stop of ours leaves.
    for (const scenario of [
      { hang: true, policy: { wallClockSeconds: 1 }, outcome: "timed_out" },
      { floodStdout: 100_000, policy: { outputBytes: 1_000 }, outcome: "output_limit_exceeded" },
    ] as const) {
      const t = await setup({
        ...("hang" in scenario ? { hang: true } : { floodStdout: scenario.floodStdout }),
        inspect: JSON.stringify({ Running: false, OOMKilled: false, ExitCode: 137 }),
      });
      const result = await t.driver.run(t.request({ policy: policyWith(scenario.policy) }));
      expect(result.outcome).toBe(scenario.outcome);
    }
  });

  it("reports the reason that came first when a limit was reached and the memory ran out too", async () => {
    const t = await setup({
      hang: true,
      inspect: JSON.stringify({ Running: false, OOMKilled: true, ExitCode: 137 }),
    });
    const result = await t.driver.run(t.request({ policy: policyWith({ wallClockSeconds: 1 }) }));
    expect(result.outcome).toBe("timed_out");
  });

  it("keeps characters that were cut in the middle from breaking the text", async () => {
    const t = await setup({ stdout: "é".repeat(1_000) });
    const result = await t.driver.run(t.request({ policy: policyWith({ outputBytes: 1_001 }) }));
    expect(result.stdoutTruncated).toBe(true);
    // 1001 bytes is half a character past 500 whole ones. The half would become three bytes of
    // replacement character, which is over the limit, so it is left out and the text says it was cut.
    expect(result.stdout).toBe("é".repeat(500));
  });
});

describe("the size of what a run returns", () => {
  // The limit is in bytes. A byte that is not text becomes U+FFFD, which is three bytes, so a program
  // could get back three times the limit by writing bytes that are not text.
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const raw = (...parts: (Buffer | string)[]) =>
    Buffer.concat(
      parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part)),
    ).toString("base64");

  it("is never more than the limit, even when every byte is one that is not text", async () => {
    const t = await setup({
      stdoutBase64: raw(Buffer.alloc(1_000, 0xff)),
      stderrBase64: raw(Buffer.alloc(1_000, 0xfe)),
    });
    const result = await t.driver.run(t.request({ policy: policyWith({ outputBytes: 1_000 }) }));
    expect(bytes(result.stdout)).toBeLessThanOrEqual(1_000);
    expect(bytes(result.stderr)).toBeLessThanOrEqual(1_000);
    // The program wrote exactly the limit, so it was not stopped, but what it wrote did not all fit.
    expect(result.outcome).toBe("exited");
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });

  it("is never more than the limit when the program wrote far more than the limit", async () => {
    const t = await setup({ stdoutBase64: raw(Buffer.alloc(50_000, 0xff)) });
    const result = await t.driver.run(t.request({ policy: policyWith({ outputBytes: 1_000 }) }));
    expect(result.outcome).toBe("output_limit_exceeded");
    expect(bytes(result.stdout)).toBeLessThanOrEqual(1_000);
    expect(result.stdout).toBe("\uFFFD".repeat(333));
    expect(result.stdoutTruncated).toBe(true);
  });

  it("keeps the text that fits, cuts at a whole character, and says that it was cut", async () => {
    const t = await setup({
      stdoutBase64: raw("ok", Buffer.from([0xff, 0xff]), "a".repeat(2_000)),
    });
    const result = await t.driver.run(t.request({ policy: policyWith({ outputBytes: 100 }) }));
    expect(result.stdoutTruncated).toBe(true);
    expect(result.outcome).toBe("output_limit_exceeded");
    // 100 bytes were kept, which are 104 bytes as text; the last four characters are left out.
    expect(result.stdout).toBe(`ok\uFFFD\uFFFD${"a".repeat(92)}`);
    expect(bytes(result.stdout)).toBe(100);
  });

  it("is the same text as before when it fits, and is not reported as cut", async () => {
    const t = await setup({ stdoutBase64: raw("ok", Buffer.from([0xff]), " é 日本 \u{1F600}") });
    const result = await t.driver.run(t.request({ policy: policyWith({ outputBytes: 1_000 }) }));
    expect(result.stdout).toBe("ok\uFFFD é 日本 \u{1F600}");
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
    expect(result.outcome).toBe("exited");
  });

  it("counts every size of character by the bytes it takes", async () => {
    // The last character that takes 1, 2 and 3 bytes and the first that takes 2, 3 and 4. After the
    // characters come bytes that are not text, up to the limit, and how many replacements fit after
    // the characters says whether the characters were counted right.
    const sizes: [string, number][] = [
      ["\u007f", 1],
      ["\u0080", 2],
      ["\u07ff", 2],
      ["\u0800", 3],
      ["\uffff", 3],
      ["\u{10000}", 4],
    ];
    const limit = 20;
    for (const [character, size] of sizes) {
      const count = Math.floor(16 / size);
      const rest = limit - count * size;
      const t = await setup({
        stdoutBase64: raw(character.repeat(count), Buffer.alloc(rest, 0xff)),
      });
      const result = await t.driver.run(t.request({ policy: policyWith({ outputBytes: limit }) }));
      expect(bytes(character), `U+${character.codePointAt(0)?.toString(16)}`).toBe(size);
      expect(result.stdout, `U+${character.codePointAt(0)?.toString(16)}`).toBe(
        character.repeat(count) + "\uFFFD".repeat(Math.floor(rest / 3)),
      );
    }
  });

  it("is never more than the limit wherever a character is cut", async () => {
    // Characters of four bytes, with the limit at each place in one of them.
    for (const limit of [1_000, 1_001, 1_002, 1_003, 1_004]) {
      const t = await setup({ stdoutBase64: raw("\u{1F600}".repeat(1_000)) });
      const result = await t.driver.run(t.request({ policy: policyWith({ outputBytes: limit }) }));
      expect(bytes(result.stdout), `limit ${limit}`).toBeLessThanOrEqual(limit);
      // Whole characters, and at most one replacement for the one that was cut.
      expect(result.stdout.replace(/\uFFFD$/u, ""), `limit ${limit}`).toBe(
        "\u{1F600}".repeat(Math.floor(limit / 4)),
      );
      expect(result.stdoutTruncated, `limit ${limit}`).toBe(true);
    }
  });
});

describe("a run that could not happen or could not be finished", () => {
  it("is unavailable when there is no docker command, and does not go on", async () => {
    const t = await setup({}, { dockerCommand: "/nonexistent/docker" });
    await expect(t.driver.run(t.request())).rejects.toMatchObject({
      name: "SandboxError",
      code: "unavailable",
    });
  });

  it("is unavailable when the daemon does not answer", async () => {
    const t = await setup({ create: 1, version: 1 });
    await expect(t.driver.run(t.request())).rejects.toMatchObject({ code: "unavailable" });
    expect(verbs(await t.calls())).toEqual(["create", "version"]);
  });

  it("has failed to start when the daemon answers but the container cannot be created", async () => {
    const t = await setup({ create: 125, version: 0 });
    await expect(t.driver.run(t.request())).rejects.toMatchObject({ code: "start_failed" });
    expect(verbs(await t.calls())).toEqual(["create", "version"]);
  });

  it("does not know how the run ended when the container cannot be inspected, and still removes it", async () => {
    const t = await setup({ inspectExit: 1, inspect: "" });
    await expect(t.driver.run(t.request())).rejects.toMatchObject({ code: "run_failed" });
    expect(verbs(await t.calls())).toEqual(["create", "start", "inspect", "rm"]);
  });

  it.each([
    ["text that is not JSON", "not json"],
    ["nothing", ""],
    [
      "a container that is still running",
      JSON.stringify({ Running: true, OOMKilled: false, ExitCode: 0 }),
    ],
    ["no exit code", JSON.stringify({ Running: false, OOMKilled: false })],
    [
      "an exit code that is not a number",
      JSON.stringify({ Running: false, OOMKilled: false, ExitCode: "0" }),
    ],
    ["a fractional exit code", JSON.stringify({ Running: false, OOMKilled: false, ExitCode: 1.5 })],
    ["no memory flag", JSON.stringify({ Running: false, ExitCode: 0 })],
    ["no running flag", JSON.stringify({ OOMKilled: false, ExitCode: 0 })],
    ["null", "null"],
  ])("does not trust what inspect says when it is %s", async (_what, inspect) => {
    const t = await setup({ inspect });
    await expect(t.driver.run(t.request())).rejects.toMatchObject({ code: "run_failed" });
    expect((await t.calls()).at(-1)?.args[0]).toBe("rm");
  });

  it("fails with a cleanup error when the container cannot be removed, even if the run went well", async () => {
    const t = await setup({ rm: 1 });
    await expect(t.driver.run(t.request())).rejects.toMatchObject({ code: "cleanup_failed" });
  });

  it("puts the cleanup error before the other one, because a container that is left may be running", async () => {
    const t = await setup({ rm: 1, inspectExit: 1 });
    await expect(t.driver.run(t.request())).rejects.toMatchObject({ code: "cleanup_failed" });
  });

  it("says only a fixed sentence about any of these", async () => {
    const t = await setup({ create: 125, version: 0, stdout: "secret-in-output" });
    const error = await t.driver.run(t.request()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxError).message).toBe("the sandbox could not be started");
  });
});

describe("a request that the driver must not run", () => {
  it("is refused when it was not made by validateRunRequest, before anything is done", async () => {
    const t = await setup();
    const checked = t.request();
    await expect(t.driver.run({ ...checked })).rejects.toBeInstanceOf(SandboxRequestError);
    await expect(t.driver.run({} as SandboxRunRequest)).rejects.toBeInstanceOf(SandboxRequestError);
    expect(await t.calls()).toEqual([]);
  });
});

describe("the source directory", () => {
  it("is mounted by its resolved path, which has to be a directory inside the workspace", async () => {
    const t = await setup();
    await mkdir(join(t.work, "real"));
    await symlink(join(t.work, "real"), join(t.work, "alias"));
    await t.driver.run(t.request({ sourceDirectory: join(t.work, "alias") }));
    const create = (await t.calls())[0]?.args ?? [];
    expect(create).toContain(
      `--mount=type=bind,src=${join(t.work, "real")},dst=/workspace,readonly`,
    );
  });

  it("is refused when a link leads out of the workspace, and nothing is created", async () => {
    const t = await setup();
    await mkdir(join(t.base, "outside"));
    await symlink(join(t.base, "outside"), join(t.work, "escape"));
    await expect(
      t.driver.run(t.request({ sourceDirectory: join(t.work, "escape") })),
    ).rejects.toMatchObject({ code: "source_not_allowed" });
    expect(await t.calls()).toEqual([]);
  });

  it("is refused when a link leads to the workspace itself, to the host, or to a place above", async () => {
    const t = await setup();
    await symlink(t.work, join(t.work, "to-root"));
    await symlink("/", join(t.work, "to-host"));
    await symlink(t.base, join(t.work, "to-parent"));
    for (const name of ["to-root", "to-host", "to-parent"]) {
      await expect(
        t.driver.run(t.request({ sourceDirectory: join(t.work, name) })),
      ).rejects.toMatchObject({ code: "source_not_allowed" });
    }
    expect(await t.calls()).toEqual([]);
  });

  it("is refused when it does not exist or is not a directory", async () => {
    const t = await setup();
    await writeFile(join(t.work, "a-file"), "x");
    for (const path of [join(t.work, "missing"), join(t.work, "a-file")]) {
      await expect(t.driver.run(t.request({ sourceDirectory: path }))).rejects.toMatchObject({
        code: "source_not_allowed",
      });
    }
    expect(await t.calls()).toEqual([]);
  });

  it("is refused when the workspace root itself cannot be resolved", async () => {
    const t = await setup({}, { workspaceRoot: "/nonexistent/work" });
    await expect(t.driver.run(t.request())).rejects.toMatchObject({ code: "source_not_allowed" });
    expect(await t.calls()).toEqual([]);
  });

  it("is not needed when the policy has no source mount", async () => {
    const t = await setup();
    const policy = validPolicyInput();
    delete policy.mounts.source;
    const request = validateRunRequest({ policy, command: ["true"] }, { workspaceRoot: t.work });
    const result = await t.driver.run(request);
    expect(result.outcome).toBe("exited");
    expect((await t.calls())[0]?.args.some((arg) => arg.startsWith("--mount"))).toBe(false);
  });
});

describe("the environment of the docker command", () => {
  it("is a short list from this process, and never the whole of it", async () => {
    const previous = {
      marker: process.env["CODEMUGS_MARKER_SECRET"],
      host: process.env["DOCKER_HOST"],
    };
    process.env["CODEMUGS_MARKER_SECRET"] = "must-not-be-passed-on";
    process.env["DOCKER_HOST"] = "tcp://daemon.invalid:2375";
    try {
      const t = await setup();
      await t.driver.run(t.request());
      const env = (await t.calls())[0]?.env ?? [];
      expect(env).toContain("DOCKER_HOST");
      expect(env).not.toContain("CODEMUGS_MARKER_SECRET");
    } finally {
      if (previous.marker === undefined) delete process.env["CODEMUGS_MARKER_SECRET"];
      else process.env["CODEMUGS_MARKER_SECRET"] = previous.marker;
      if (previous.host === undefined) delete process.env["DOCKER_HOST"];
      else process.env["DOCKER_HOST"] = previous.host;
    }
  });

  it("is exactly what was given, when something was given", async () => {
    const t = await setup({}, { environment: { DOCKER_HOST: "unix:///run/special.sock" } });
    await t.driver.run(t.request());
    const env = (await t.calls())[0]?.env ?? [];
    expect(env).toContain("DOCKER_HOST");
    expect(env).not.toContain("HOME");
    expect(env).not.toContain("CODEMUGS_MARKER_SECRET");
  });
});

describe("a container that could not be started", () => {
  it("is reported as not started, without anything docker or the program said", async () => {
    const t = await setup({
      exitCode: 127,
      stateError: "failed to create task: exec /host/secret/path/tool: no such file",
      stderr: "docker: Error response from daemon: /host/secret/path/tool",
      stdout: "partial output",
    });
    const error = await t.driver.run(t.request()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toMatchObject({
      code: "start_failed",
      message: "the sandbox could not be started",
    });
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(verbs(await t.calls())).toEqual(["create", "start", "inspect", "rm"]);
  });

  it("is still reported as stopped for a limit of ours, when that came first", async () => {
    const t = await setup({ floodStdout: 200_000, stateError: "some start error" });
    const result = await t.driver.run(t.request({ policy: policyWith({ outputBytes: 1_000 }) }));
    expect(result.outcome).toBe("output_limit_exceeded");
  });

  it("is not assumed when docker leaves the reason out or gives it as something else", async () => {
    const t = await setup({
      inspect: JSON.stringify({ Running: false, OOMKilled: false, ExitCode: 3, Error: 5 }),
    });
    expect(await t.driver.run(t.request())).toMatchObject({ outcome: "exited", exitCode: 3 });
  });
});

describe("the gVisor driver", () => {
  const RUNSC = JSON.stringify({
    "io.containerd.runc.v2": { path: "runc" },
    runsc: { path: "/usr/local/bin/runsc" },
  });
  const gvisor = (t: Awaited<ReturnType<typeof setup>>) =>
    createGvisorDriver({
      workspaceRoot: t.work,
      dockerCommand: join(t.base, "bin", "docker"),
      stopGraceMs: 300,
    });

  it("is called gvisor, and is stronger than a hardened container and weaker than a microvm", async () => {
    const driver = gvisor(await setup());
    expect(driver.name).toBe("gvisor");
    expect(driver.isolation).toBe("gvisor");
    expect(isolationAtLeast(driver.isolation, "hardened-container")).toBe(true);
    expect(isolationAtLeast(driver.isolation, "microvm")).toBe(false);
  });

  it("is available when the daemon answers and has the runsc runtime, and asks nothing else", async () => {
    const t = await setup({ info: RUNSC });
    expect(await gvisor(t).availability()).toEqual({ available: true });
    const calls = await t.calls();
    expect(verbs(calls)).toEqual(["version", "info"]);
    expect(calls[1]?.args).toEqual(["info", "--format", "{{json .Runtimes}}"]);
  });

  it("does not ask about runtimes when the daemon does not answer", async () => {
    const t = await setup({ version: 1, info: RUNSC });
    expect(await gvisor(t).availability()).toEqual({
      available: false,
      reason: "the docker daemon did not answer",
    });
    expect(verbs(await t.calls())).toEqual(["version"]);
  });

  it.each([
    ["has no runsc runtime", JSON.stringify({ "io.containerd.runc.v2": { path: "runc" } })],
    ["says nothing", "{}"],
    ["gives null", "null"],
    ["gives a list", "[]"],
    ["gives text", JSON.stringify("runsc")],
    ["gives runsc as text", JSON.stringify({ runsc: "/usr/local/bin/runsc" })],
    ["gives runsc as nothing", JSON.stringify({ runsc: null })],
  ])("is not available when the daemon %s", async (_what, info) => {
    const t = await setup({ info });
    expect(await gvisor(t).availability()).toEqual({
      available: false,
      reason: "the runsc runtime is not registered with docker",
    });
  });

  it.each([
    ["runc", JSON.stringify({ runsc: { path: "/usr/bin/runc" } })],
    ["a path that only ends like it", JSON.stringify({ runsc: { path: "/usr/bin/not-runsc" } })],
    ["no path", JSON.stringify({ runsc: {} })],
    ["a path that is not text", JSON.stringify({ runsc: { path: 7 } })],
    ["a path that is a list", JSON.stringify({ runsc: { path: ["runsc"] } })],
  ])("is not available when the runtime called runsc points to %s", async (_what, info) => {
    const t = await setup({ info });
    expect(await gvisor(t).availability()).toEqual({
      available: false,
      reason: "the runtime called runsc does not point to runsc",
    });
  });

  it("is not available when the daemon cannot say which runtimes it has", async () => {
    for (const scenario of [{ infoExit: 1 }, { info: "not json at all" }]) {
      const t = await setup(scenario);
      expect(await gvisor(t).availability()).toEqual({
        available: false,
        reason: "the docker daemon did not say which runtimes it has",
      });
    }
  });

  it("creates its containers with the runsc runtime, and the docker driver does not", async () => {
    const t = await setup({ stdout: "ok" });
    const result = await gvisor(t).run(t.request());
    expect(result).toMatchObject({ outcome: "exited", exitCode: 0, stdout: "ok" });
    const create = (await t.calls()).find((call) => call.args[0] === "create");
    expect(create?.args.filter((arg) => arg.startsWith("--runtime"))).toEqual(["--runtime=runsc"]);

    const plain = await setup({ stdout: "ok" });
    await plain.driver.run(plain.request());
    const plainCreate = (await plain.calls()).find((call) => call.args[0] === "create");
    expect(plainCreate?.args.some((arg) => arg.startsWith("--runtime"))).toBe(false);
  });

  it("makes the same calls in the same order, and refuses what the docker driver refuses", async () => {
    const t = await setup({ stdout: "ok" });
    await gvisor(t).run(t.request());
    expect(verbs(await t.calls())).toEqual(["create", "start", "inspect", "rm"]);
    await expect(gvisor(t).run({} as SandboxRunRequest)).rejects.toThrow();
  });

  it("reports a failed create as unavailable when the runsc runtime is not there", async () => {
    const t = await setup({ create: 125, info: "{}" });
    await expect(gvisor(t).run(t.request())).rejects.toMatchObject({ code: "unavailable" });
    expect(verbs(await t.calls())).toEqual(["create", "version", "info"]);
  });

  it("reports a failed create as a start failure when the runtime is there", async () => {
    const t = await setup({ create: 125, info: RUNSC });
    await expect(gvisor(t).run(t.request())).rejects.toMatchObject({ code: "start_failed" });
    expect(verbs(await t.calls())).toEqual(["create", "version", "info"]);
  });
});
