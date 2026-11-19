import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tarball, type FixtureEntry } from "@codemugs/archive/testing";
import {
  assertValidatedRequest,
  type SandboxDriver,
  type SandboxResult,
  type SandboxRunRequest,
} from "@codemugs/sandbox-manager";

/**
 * Drivers and archives for the tests of this package, shared by the tests of an analysis of a
 * directory and of an archive. Not part of the build.
 */

const run = promisify(execFile);

export const IMAGE = `docker.io/library/node@sha256:${"a".repeat(64)}`;

export const exited = (overrides: Partial<SandboxResult> = {}): SandboxResult => ({
  outcome: "exited",
  exitCode: 0,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 1,
  ...overrides,
});

/** A driver that records what it is asked and answers with what the test gives it. */
export function fakeDriver(
  answer: (request: SandboxRunRequest) => Promise<SandboxResult> | SandboxResult,
  overrides: Partial<SandboxDriver> = {},
): SandboxDriver & { requests: SandboxRunRequest[] } {
  const requests: SandboxRunRequest[] = [];
  return {
    requests,
    name: "fake",
    isolation: "gvisor",
    availability: () => Promise.resolve({ available: true }),
    async run(request) {
      requests.push(request);
      return answer(request);
    },
    ...overrides,
  };
}

/**
 * A stand-in that runs the command on this machine, with no isolation at all, where `/workspace` is
 * the staged directory. It is for tests, over files that the tests wrote: it shows that the host's
 * side of an analysis works from the staging to the facts, and it says nothing of isolation, which
 * the tests against a real driver (`sandbox.integration.test.ts`) are for.
 */
export function standIn(): SandboxDriver {
  return {
    name: "stand-in",
    isolation: "hardened-container",
    availability: () => Promise.resolve({ available: true }),
    async run(request) {
      assertValidatedRequest(request);
      const source = request.sourceDirectory;
      if (source === null) throw new Error("the analysis needs a source");
      const [, ...args] = request.command;
      const mapped = args
        .filter((argument) => !argument.startsWith("--max-old-space-size"))
        .map((argument) => argument.replace(/^\/workspace/, source));
      try {
        const { stdout } = await run(process.execPath, mapped, { maxBuffer: 64 * 1024 * 1024 });
        return exited({ stdout });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return exited({ exitCode: typeof code === "number" ? code : 1 });
      }
    },
  };
}

/**
 * An archive of what a directory holds, the way GitHub makes one: gzip, and every path under one
 * top directory. Files and directories only, in a fixed order; a link is left out.
 */
export async function archiveOfDirectory(root: string, top = "repo-0123abc"): Promise<Buffer> {
  const entries: FixtureEntry[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const found = await readdir(directory, { withFileTypes: true });
    for (const entry of found.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        entries.push({ name: `${path}/`, type: "directory" });
        await walk(join(directory, entry.name), `${path}/`);
      } else if (entry.isFile()) {
        entries.push({ name: path, content: await readFile(join(directory, entry.name)) });
      }
    }
  };
  await walk(root, `${top}/`);
  return tarball(entries);
}
