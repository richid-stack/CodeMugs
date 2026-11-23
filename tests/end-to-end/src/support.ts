// Shared by the test of the whole path. Not part of any build.
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tarball, type FixtureEntry } from "@codemugs/archive/testing";
import {
  assertValidatedRequest,
  type SandboxDriver,
  type SandboxResult,
} from "@codemugs/sandbox-manager";

const run = promisify(execFile);

/**
 * A stand-in for the sandbox that runs the analysis command on this machine, with no isolation at
 * all, where `/workspace` is the staged directory. It is used only where there is no docker daemon,
 * over a repository that this repository holds, and it shows the path from the request to the graph
 * and nothing of isolation. The test says which of the two it ran with.
 */
export function standInSandbox(): SandboxDriver {
  const exited = (overrides: Partial<SandboxResult>): SandboxResult => ({
    outcome: "exited",
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    ...overrides,
  });
  return {
    name: "stand-in",
    isolation: "hardened-container",
    availability: () => Promise.resolve({ available: true }),
    async run(request) {
      assertValidatedRequest(request);
      // The check of the process's own startup: a fixed command of ours that prints one word.
      if (request.sourceDirectory === null || request.command[1] === "-e") {
        const { stdout } = await run(process.execPath, request.command.slice(1));
        return exited({ stdout });
      }
      const [, ...args] = request.command;
      const mapped = args
        .filter((argument) => !argument.startsWith("--max-old-space-size"))
        .map((argument) => argument.replace(/^\/workspace/, request.sourceDirectory ?? ""));
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
 * top directory. Files and directories only; a link is left out.
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

/** An RSA key in the form that GitHub gives (a `.pem`), made here so that no key is in the repository. */
export function throwawayPrivateKey(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString()
    .trim();
}
