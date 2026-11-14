import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { assertValidatedRequest, type SandboxRunRequest } from "../request.js";
import { isInside } from "../paths.js";
import {
  SandboxError,
  type Availability,
  type IsolationLevel,
  type SandboxDriver,
  type SandboxOutcome,
  type SandboxResult,
} from "../driver.js";
import { dockerCreateArguments } from "./arguments.js";
import { newRunUser } from "./run-user.js";

export interface DockerDriverOptions {
  /**
   * The folder the sandbox manager keeps its working copies in, the same one that
   * `validateRunRequest` was given. The driver resolves symbolic links before it mounts a source
   * directory and refuses one that ends up outside it.
   */
  readonly workspaceRoot: string;
  /** The docker command to run. Default `docker`. */
  readonly dockerCommand?: string;
  /**
   * The environment the docker command gets. By default a short list taken from this process
   * (where to find docker and how to reach the daemon). The environment of this process is never
   * passed on as a whole, and nothing of it reaches the sandbox either way.
   */
  readonly environment?: Readonly<Record<string, string>>;
  /** How long to wait for the docker client to end after the container was killed. Default 15 s. */
  readonly stopGraceMs?: number;
}

const INHERITED = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "XDG_RUNTIME_DIR",
] as const;

/** What a docker command may print before we stop keeping it: these are our own commands, not the program's. */
const CONTROL_OUTPUT_LIMIT = 64 * 1_024;
const CONTROL_TIMEOUT_MS = 60_000;
const AVAILABILITY_TIMEOUT_MS = 10_000;

interface Finished {
  /** The exit code, or null if the command did not run or was killed. */
  readonly code: number | null;
  readonly stdout: string;
  /** True when the docker command could not be started at all (for example it does not exist). */
  readonly notStarted: boolean;
}

/** What differs between the drivers that run containers through the docker command. */
interface Variant {
  readonly name: string;
  readonly isolation: IsolationLevel;
  /** The docker runtime to ask for by name, or nothing for the daemon's default. */
  readonly runtime: string | undefined;
  /** What is checked, besides the daemon answering, before the driver says it is available. */
  readonly checkRuntime: ((control: Control) => Promise<Availability>) | undefined;
}

type Control = (args: readonly string[], timeoutMs: number) => Promise<Finished>;

/** Keeps at most `limit` bytes and notes that there was more. */
class Capture {
  readonly #chunks: Buffer[] = [];
  #size = 0;
  /** True once the program has written more than `limit` bytes. */
  truncated = false;

  constructor(readonly limit: number) {}

  add(chunk: Buffer): void {
    const room = this.limit - this.#size;
    if (chunk.length > room) this.truncated = true;
    if (room > 0) {
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      this.#chunks.push(kept);
      this.#size += kept.length;
    }
  }

  /**
   * The text, which is never more than `limit` bytes long. At most `limit` bytes were kept, but a
   * byte that is not text, or a character that was cut in the middle, becomes U+FFFD, which is three
   * bytes. A program could get back three times the limit by writing bytes that are not text. So the
   * text is cut again, at a whole character, and is then reported as cut.
   */
  result(): { readonly text: string; readonly truncated: boolean } {
    const decoded = Buffer.concat(this.#chunks).toString("utf8");
    const text = withinBytes(decoded, this.limit);
    return { text, truncated: this.truncated || text.length < decoded.length };
  }
}

function utf8Size(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  return codePoint < 0x10000 ? 3 : 4;
}

/** The longest start of `text` that is at most `limit` bytes in UTF-8 and ends between characters. */
function withinBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let used = 0;
  let end = 0;
  for (const character of text) {
    const size = utf8Size(character.codePointAt(0) ?? 0);
    if (used + size > limit) break;
    used += size;
    end += character.length;
  }
  return text.slice(0, end);
}

/** 128 + 9: how a program that was ended by SIGKILL, as the kernel does for memory, looks to its parent. */
const KILLED_BY_SIGKILL = 137;

/**
 * The first driver: a hardened container, run by the docker command. It is the weakest of the
 * isolation levels, since the container shares the host's kernel, and is not enough for hostile
 * third-party code (ADR 0007 decision 5, ADR 0017).
 */
export function createDockerDriver(options: DockerDriverOptions): SandboxDriver {
  return createContainerDriver(options, {
    name: "docker",
    isolation: "hardened-container",
    runtime: undefined,
    checkRuntime: undefined,
  });
}

/** The name `runsc install` gives the gVisor runtime in the docker daemon's configuration. */
const GVISOR_RUNTIME = "runsc";

/**
 * The same hardened container, run by gVisor (`runsc`) instead of the host's kernel: the program's
 * system calls are answered by gVisor's own kernel in user space and not by the host's (ADR 0018).
 * It needs the `runsc` runtime registered with the docker daemon, and refuses to run otherwise: a
 * missing runtime is an error, never a fall back to the daemon's default.
 */
export function createGvisorDriver(options: DockerDriverOptions): SandboxDriver {
  return createContainerDriver(options, {
    name: "gvisor",
    isolation: "gvisor",
    runtime: GVISOR_RUNTIME,
    checkRuntime: checkGvisorRuntime,
  });
}

/**
 * Asks the daemon which runtimes it has. A runtime called `runsc` that points somewhere else would
 * make this driver claim an isolation it does not give, so its path has to end in `runsc`. This
 * catches a mistake in the configuration. It is not a defence against a daemon that lies.
 */
async function checkGvisorRuntime(control: Control): Promise<Availability> {
  const info = await control(["info", "--format", "{{json .Runtimes}}"], AVAILABILITY_TIMEOUT_MS);
  if (info.code !== 0) {
    return { available: false, reason: "the docker daemon did not say which runtimes it has" };
  }
  let runtimes: unknown;
  try {
    runtimes = JSON.parse(info.stdout);
  } catch {
    return { available: false, reason: "the docker daemon did not say which runtimes it has" };
  }
  const entry =
    typeof runtimes === "object" && runtimes !== null
      ? (runtimes as Record<string, unknown>)[GVISOR_RUNTIME]
      : undefined;
  if (typeof entry !== "object" || entry === null) {
    return { available: false, reason: "the runsc runtime is not registered with docker" };
  }
  const path = (entry as Record<string, unknown>)["path"];
  if (typeof path !== "string" || path.split("/").at(-1) !== GVISOR_RUNTIME) {
    return { available: false, reason: "the runtime called runsc does not point to runsc" };
  }
  return { available: true };
}

function createContainerDriver(options: DockerDriverOptions, variant: Variant): SandboxDriver {
  const command = options.dockerCommand ?? "docker";
  const graceMs = options.stopGraceMs ?? 15_000;
  const environment: Record<string, string> =
    options.environment === undefined
      ? Object.fromEntries(
          INHERITED.flatMap((name) => {
            const value = process.env[name];
            return value === undefined ? [] : [[name, value] as const];
          }),
        )
      : { ...options.environment };

  /** Runs a docker command to the end, keeping a bounded amount of what it prints. */
  const control: Control = (args, timeoutMs) => {
    return new Promise((resolve) => {
      const child = spawn(command, args, { env: environment, stdio: ["ignore", "pipe", "ignore"] });
      const out = new Capture(CONTROL_OUTPUT_LIMIT);
      let settled = false;
      const done = (finished: Finished): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(finished);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done({ code: null, stdout: out.result().text, notStarted: false });
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => out.add(chunk));
      child.on("error", () => done({ code: null, stdout: "", notStarted: true }));
      child.on("close", (code) => done({ code, stdout: out.result().text, notStarted: false }));
    });
  };

  async function availability(): Promise<Availability> {
    const result = await control(
      ["version", "--format", "{{.Server.Version}}"],
      AVAILABILITY_TIMEOUT_MS,
    );
    if (result.notStarted) return { available: false, reason: "the docker command was not found" };
    if (result.code !== 0) return { available: false, reason: "the docker daemon did not answer" };
    return variant.checkRuntime === undefined ? { available: true } : variant.checkRuntime(control);
  }

  /**
   * The source directory as the daemon will see it: with every link resolved, which has to be a
   * directory inside the (resolved) workspace. Throws `source_not_allowed` if it is not.
   */
  async function resolveSource(request: SandboxRunRequest): Promise<SandboxRunRequest> {
    if (request.sourceDirectory === null) return request;
    let resolved: string;
    try {
      const root = await realpath(options.workspaceRoot);
      resolved = await realpath(request.sourceDirectory);
      if (!isInside(resolved, root) || resolved === root || !(await stat(resolved)).isDirectory()) {
        throw new SandboxError("source_not_allowed");
      }
    } catch (error) {
      throw error instanceof SandboxError ? error : new SandboxError("source_not_allowed");
    }
    return Object.freeze({ ...request, sourceDirectory: resolved });
  }

  async function execute(name: string, request: SandboxRunRequest): Promise<SandboxResult> {
    const { limits } = request.policy;
    const started = Date.now();
    const child = spawn(command, ["start", "--attach", name], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new Capture(limits.outputBytes);
    const stderr = new Capture(limits.outputBytes);
    let reason: "timed_out" | "output_limit_exceeded" | null = null;
    let killer: NodeJS.Timeout | undefined;
    let killing: Promise<Finished> | undefined;

    /** Stops the container, once, for the first reason found. */
    const stop = (why: "timed_out" | "output_limit_exceeded"): void => {
      if (reason !== null) return;
      reason = why;
      killing = control(["kill", name], CONTROL_TIMEOUT_MS);
      // If the docker client does not end after the kill, end it, so that cleanup can go on.
      killer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    };

    const timer = setTimeout(() => stop("timed_out"), limits.wallClockSeconds * 1_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.add(chunk);
      if (stdout.truncated) stop("output_limit_exceeded");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.add(chunk);
      if (stderr.truncated) stop("output_limit_exceeded");
    });

    const ended = await new Promise<"ended" | "not_started">((resolve) => {
      child.on("error", () => resolve("not_started"));
      child.on("close", () => resolve("ended"));
    });
    clearTimeout(timer);
    if (killer !== undefined) clearTimeout(killer);
    // The kill is waited for, so that nothing of ours is still running when the state is read and
    // the container removed, and so that the order of the docker commands does not depend on timing.
    await killing;
    if (ended === "not_started") throw new SandboxError("start_failed");
    const durationMs = Date.now() - started;

    const inspected = await control(
      ["inspect", "--format", "{{json .State}}", name],
      CONTROL_TIMEOUT_MS,
    );
    const state = inspected.code === 0 ? parseState(inspected.stdout) : undefined;
    if (state === undefined || state.running) throw new SandboxError("run_failed");
    // Docker keeps the reason a container could not be started (a program that is not there, a
    // runtime that could not make its sandbox). The client prints it among what the program
    // printed, so it is not kept: the run is reported as not started, and what was captured is
    // dropped with it. A limit of ours that stopped the run comes first.
    if (reason === null && state.error !== "") throw new SandboxError("start_failed");

    let outcome: SandboxOutcome;
    let exitCode: number | null;
    if (reason !== null) {
      outcome = reason;
      exitCode = null;
    } else if (state.oomKilled || state.exitCode === KILLED_BY_SIGKILL) {
      // Docker's record of an out-of-memory kill is sometimes missed under the hardened container
      // (2 of 40 runs, and 5 of 40 with four running at once, in the probe of ADR 0020), and then
      // all that is left is that the program ended by SIGKILL. Nothing inside the sandbox can send
      // that to the first process, and a kill of ours is reported above, so it is read as the
      // memory limit. A program that exits with 137 on its own is read the same way.
      outcome = "out_of_memory";
      exitCode = null;
    } else {
      outcome = "exited";
      exitCode = state.exitCode;
    }
    const out = stdout.result();
    const err = stderr.result();
    return {
      outcome,
      exitCode,
      stdout: out.text,
      stderr: err.text,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
      durationMs,
    };
  }

  return {
    name: variant.name,
    isolation: variant.isolation,
    availability,

    async run(input: SandboxRunRequest): Promise<SandboxResult> {
      assertValidatedRequest(input);
      const request = await resolveSource(input);
      const name = `codemugs-sandbox-${randomUUID()}`;

      const created = await control(
        dockerCreateArguments(request, name, newRunUser(), variant.runtime),
        CONTROL_TIMEOUT_MS,
      );
      if (created.code !== 0) {
        throw new SandboxError((await availability()).available ? "start_failed" : "unavailable");
      }

      let result: SandboxResult | undefined;
      let failure: Error | undefined;
      try {
        result = await execute(name, request);
      } catch (error) {
        failure = error instanceof Error ? error : new SandboxError("run_failed");
      }
      // Whatever happened, the container goes. A container that cannot be removed may still be
      // running, which matters more than the result.
      const removed = await control(["rm", "--force", "--volumes", name], CONTROL_TIMEOUT_MS);
      if (removed.code !== 0) throw new SandboxError("cleanup_failed");
      if (failure !== undefined) throw failure;
      if (result === undefined) throw new SandboxError("run_failed");
      return result;
    },
  };
}

interface ContainerState {
  readonly running: boolean;
  readonly oomKilled: boolean;
  readonly exitCode: number;
  /** What docker recorded as the reason the container could not be started, or an empty string. */
  readonly error: string;
}

/** Reads the fields we need from `docker inspect --format {{json .State}}`, or nothing. */
function parseState(text: string): ContainerState | undefined {
  try {
    const state = JSON.parse(text) as Record<string, unknown>;
    const { Running: running, OOMKilled: oomKilled, ExitCode: exitCode, Error: error } = state;
    if (
      typeof running !== "boolean" ||
      typeof oomKilled !== "boolean" ||
      typeof exitCode !== "number" ||
      !Number.isInteger(exitCode)
    ) {
      return undefined;
    }
    return { running, oomKilled, exitCode, error: typeof error === "string" ? error : "" };
  } catch {
    return undefined;
  }
}
