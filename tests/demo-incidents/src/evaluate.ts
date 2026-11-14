import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { detectAll, type Finding, type TelemetryEvent } from "./detectors.js";

const exec = promisify(execFile);

const RUN_TESTS = fileURLToPath(new URL("../traffic/run-tests.ts", import.meta.url));
const RUN_TRAFFIC = fileURLToPath(new URL("../traffic/run-traffic.ts", import.meta.url));

/** A child process that failed to do its job, which is not the same as a test that failed. */
export class HarnessError extends Error {
  readonly script: string;
  readonly exitCode: number | null;

  constructor(script: string, exitCode: number | null, detail: string) {
    super(
      `${script} ${exitCode === null ? "did not finish" : `exited with ${exitCode}`}: ${detail}`,
    );
    this.name = "HarnessError";
    this.script = script;
    this.exitCode = exitCode;
  }
}

export interface TestOutcome {
  readonly file: string;
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped";
}

export interface Evaluation {
  readonly tests: readonly TestOutcome[];
  /** `file > name` for each test that failed, in order. */
  readonly failing: readonly string[];
  readonly findings: readonly Finding[];
  readonly statuses: Readonly<Record<string, number>>;
}

/**
 * Runs a script of this package with plain Node, in a process of its own with no environment, and
 * reads the one line of JSON that it prints. A copy of the shop has no business with this
 * machine's variables, and one that hangs is stopped.
 */
async function runScript(
  script: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<unknown> {
  const name = script.slice(script.lastIndexOf("/") + 1);
  let stdout: string;
  try {
    ({ stdout } = await exec(process.execPath, [script, ...args], {
      env: {},
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (error) {
    const failure = error as { code?: number | string; killed?: boolean; stderr?: string };
    const exitCode = typeof failure.code === "number" ? failure.code : null;
    // What the process said, without the stack frames and the blank lines: the last few that remain.
    const detail =
      failure.killed === true
        ? "timed out"
        : (failure.stderr ?? "")
            .split("\n")
            .filter((line) => line.trim() !== "" && !/^\s+at /.test(line))
            .slice(-4)
            .join(" | ");
    throw new HarnessError(name, exitCode, detail);
  }
  try {
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as unknown;
  } catch {
    throw new HarnessError(name, 0, "its last line of output is not JSON");
  }
}

export async function runShopTests(directory: string, timeoutMs = 120_000): Promise<TestOutcome[]> {
  const result = (await runScript(RUN_TESTS, [resolve(directory)], timeoutMs)) as {
    tests: TestOutcome[];
  };
  return result.tests;
}

export async function runShopTraffic(
  directory: string,
  seed = 1,
  timeoutMs = 120_000,
): Promise<{ events: TelemetryEvent[]; statuses: Record<string, number> }> {
  return (await runScript(RUN_TRAFFIC, [resolve(directory), String(seed)], timeoutMs)) as {
    events: TelemetryEvent[];
    statuses: Record<string, number>;
  };
}

/**
 * What a copy of the shop is like: which of its tests fail, and what its telemetry shows under the
 * traffic of `seed`. This is also how a change to a faulty copy is to be judged, by something that is
 * not the agent that made it.
 */
export async function evaluateShop(directory: string, seed = 1): Promise<Evaluation> {
  const [tests, traffic] = await Promise.all([
    runShopTests(directory),
    runShopTraffic(directory, seed),
  ]);
  return {
    tests,
    failing: tests
      .filter((test) => test.status === "failed")
      .map((test) => `${test.file} > ${test.name}`),
    findings: detectAll(traffic.events),
    statuses: traffic.statuses,
  };
}
