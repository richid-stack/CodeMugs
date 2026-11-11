import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { assertValidatedRequest, type SandboxRunRequest } from "../request.js";
import { isInside } from "../paths.js";
import {
  SandboxError,
  type Availability,
  type SandboxDriver,
  type SandboxOutcome,
  type SandboxResult,
} from "../driver.js";
import { dockerCreateArguments } from "./arguments.js";

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

/** Keeps at most `limit` bytes and notes that there was more. */
class Capture {
  readonly #chunks: Buffer[] = [];
  #size = 0;
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

  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

/**
 * The first driver: a hardened container, run by the docker command. It is the weakest of the
 * isolation levels, since the container shares the host's kernel, and is not enough for hostile
 * third-party code (ADR 0007 decision 5, ADR 0017).
 */
export function createDockerDriver(options: DockerDriverOptions): SandboxDriver {
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
  function control(args: readonly string[], timeoutMs: number): Promise<Finished> {
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
        done({ code: null, stdout: out.text(), notStarted: false });
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => out.add(chunk));
      child.on("error", () => done({ code: null, stdout: "", notStarted: true }));
      child.on("close", (code) => done({ code, stdout: out.text(), notStarted: false }));
    });
  }

  async function availability(): Promise<Availability> {
    const result = await control(
      ["version", "--format", "{{.Server.Version}}"],
      AVAILABILITY_TIMEOUT_MS,
    );
    if (result.notStarted) return { available: false, reason: "the docker command was not found" };
    if (result.code !== 0) return { available: false, reason: "the docker daemon did not answer" };
    return { available: true };
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

    /** Stops the container, once, for the first reason found. */
    const stop = (why: "timed_out" | "output_limit_exceeded"): void => {
      if (reason !== null) return;
      reason = why;
      void control(["kill", name], CONTROL_TIMEOUT_MS);
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
    if (ended === "not_started") throw new SandboxError("start_failed");
    const durationMs = Date.now() - started;

    const inspected = await control(
      ["inspect", "--format", "{{json .State}}", name],
      CONTROL_TIMEOUT_MS,
    );
    const state = inspected.code === 0 ? parseState(inspected.stdout) : undefined;
    if (state === undefined || state.running) throw new SandboxError("run_failed");

    let outcome: SandboxOutcome;
    let exitCode: number | null;
    if (reason !== null) {
      outcome = reason;
      exitCode = null;
    } else if (state.oomKilled) {
      outcome = "out_of_memory";
      exitCode = null;
    } else {
      outcome = "exited";
      exitCode = state.exitCode;
    }
    return {
      outcome,
      exitCode,
      stdout: stdout.text(),
      stderr: stderr.text(),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      durationMs,
    };
  }

  return {
    name: "docker",
    isolation: "hardened-container",
    availability,

    async run(input: SandboxRunRequest): Promise<SandboxResult> {
      assertValidatedRequest(input);
      const request = await resolveSource(input);
      const name = `codemugs-sandbox-${randomUUID()}`;

      const created = await control(dockerCreateArguments(request, name), CONTROL_TIMEOUT_MS);
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
}

/** Reads the fields we need from `docker inspect --format {{json .State}}`, or nothing. */
function parseState(text: string): ContainerState | undefined {
  try {
    const state = JSON.parse(text) as Record<string, unknown>;
    const { Running: running, OOMKilled: oomKilled, ExitCode: exitCode } = state;
    if (
      typeof running !== "boolean" ||
      typeof oomKilled !== "boolean" ||
      typeof exitCode !== "number" ||
      !Number.isInteger(exitCode)
    ) {
      return undefined;
    }
    return { running, oomKilled, exitCode };
  } catch {
    return undefined;
  }
}
