import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import type { IsolationLevel, SandboxDriver } from "../driver.js";
import { validPolicyInput, type PolicyInput } from "../fixtures.js";
import { validateRunRequest } from "../request.js";
import { SANDBOX_LABEL } from "./arguments.js";
import { createDockerDriver, createGvisorDriver, type DockerDriverOptions } from "./driver.js";

/**
 * What the tests that run real containers share: the image, the daemon, the two drivers and the
 * limits they run under. Only tests import this file, and the build leaves it out.
 */
const run = promisify(execFile);

export const image = process.env["CODEMUGS_TEST_SANDBOX_IMAGE"];

export async function docker(...args: string[]): Promise<string> {
  return (await run("docker", args)).stdout;
}

export const imagePresent =
  image !== undefined &&
  (await docker("image", "inspect", "--format", "{{.Id}}", image).then(
    () => true,
    () => false,
  ));

/**
 * The containers of ours that were made for a directory: the ones that mount a directory under it.
 * Test files run at the same time against the one daemon, so "no container of ours is left" cannot
 * be asked of the whole daemon, which has the containers of the other files in it.
 */
export async function containersOf(directory: string): Promise<string[]> {
  const ids = (await docker("ps", "-a", "-q", "--filter", `label=${SANDBOX_LABEL}`))
    .split("\n")
    .filter((id) => id !== "");
  const own: string[] = [];
  for (const id of ids) {
    // A container that another file removes between the two commands is not ours.
    const sources = await docker(
      "inspect",
      "--format",
      "{{range .Mounts}}{{.Source}}\n{{end}}",
      id,
    ).catch(() => "");
    if (sources.split("\n").some((source) => source.startsWith(`${directory}/`))) own.push(id);
  }
  return own;
}

/** A driver that can be tested, whether the machine can run it, and whether CI demands that it can. */
export interface Runtime {
  readonly name: "docker" | "gvisor";
  readonly create: (options: DockerDriverOptions) => SandboxDriver;
  readonly isolation: IsolationLevel;
  readonly usable: boolean;
  readonly required: boolean;
}

export const runtimes: readonly [Runtime, Runtime] = [
  {
    name: "docker",
    create: createDockerDriver,
    isolation: "hardened-container",
    usable:
      imagePresent && (await createDockerDriver({ workspaceRoot: "/" }).availability()).available,
    required: process.env["REQUIRE_DOCKER_TESTS"] === "true",
  },
  {
    name: "gvisor",
    create: createGvisorDriver,
    isolation: "gvisor",
    usable:
      imagePresent && (await createGvisorDriver({ workspaceRoot: "/" }).availability()).available,
    required: process.env["REQUIRE_GVISOR_TESTS"] === "true",
  },
];

/** True when the machine can run the tests, or when CI says it must (and then they fail if it cannot). */
export function mustRun(runtime: Runtime): boolean {
  return runtime.usable || runtime.required;
}

export function limitedPolicy(
  change: (policy: PolicyInput) => void = () => undefined,
): PolicyInput {
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

export interface Workspace {
  /** The driver's workspace root. */
  readonly work: () => string;
  /** The source directory, with one file in it. */
  readonly source: () => string;
  readonly driver: () => SandboxDriver;
  readonly execute: (
    command: string[],
    change?: (policy: PolicyInput) => void,
  ) => ReturnType<SandboxDriver["run"]>;
  readonly sh: (
    script: string,
    change?: (policy: PolicyInput) => void,
  ) => ReturnType<SandboxDriver["run"]>;
}

/**
 * Call inside a `describe`. It makes a workspace with a source directory before the tests, removes it
 * after them, and fails any test that leaves a container of ours behind.
 */
export function useWorkspace(runtime: Runtime, prefix: string): Workspace {
  let base: string | undefined;
  let work = "";
  let source = "";
  const driver = () => runtime.create({ workspaceRoot: work });

  beforeAll(async () => {
    if (!runtime.usable) {
      throw new Error(
        `the ${runtime.name} tests are required but there is no usable docker daemon${
          runtime.name === "gvisor" ? " with the runsc runtime" : ""
        }, or the image CODEMUGS_TEST_SANDBOX_IMAGE is not on this host`,
      );
    }
    base = await realpath(await mkdtemp(join(tmpdir(), `${prefix}-`)));
    work = join(base, "work");
    source = join(work, "src");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "hello.txt"), "hello from the source\n");
  });

  afterEach(async () => {
    // Whatever a test did, no container of ours may be left.
    if (!runtime.usable) return;
    expect(base === undefined ? [] : await containersOf(base)).toEqual([]);
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

  return {
    work: () => work,
    source: () => source,
    driver,
    execute,
    sh: (script, change) => execute(["sh", "-c", script], change),
  };
}
