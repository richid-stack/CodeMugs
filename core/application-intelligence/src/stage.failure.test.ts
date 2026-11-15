import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxDriver } from "@codemugs/sandbox-manager";
import type * as FileSystem from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AnalysisError } from "./errors.js";
import { analyseInSandbox } from "./run.js";
import { stageAnalysis } from "./stage.js";

/**
 * Failures of the disk that a test cannot make with a real one (a disk that is full, a directory
 * that cannot be removed, a directory with no end) are made here by replacing four functions of
 * `node:fs/promises` with ones that fail when a test says so, and that are the real ones otherwise.
 */
const failing = vi.hoisted(() => ({
  writeRepositoryFile: undefined as Error | undefined,
  remove: undefined as Error | undefined,
  endlessDirectory: undefined as { yielded: number } | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return {
    ...actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) =>
      failing.writeRepositoryFile !== undefined &&
      typeof args[0] === "string" &&
      args[0].includes("/repo/")
        ? Promise.reject(failing.writeRepositoryFile)
        : actual.writeFile(...args),
    rm: (...args: Parameters<typeof actual.rm>) =>
      failing.remove === undefined ? actual.rm(...args) : Promise.reject(failing.remove),
    opendir: (...args: Parameters<typeof actual.opendir>) => {
      const endless = failing.endlessDirectory;
      if (endless === undefined) return actual.opendir(...args);
      return Promise.resolve({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            endless.yielded += 1;
            return Promise.resolve({
              done: false,
              value: {
                name: `f${String(endless.yielded)}`,
                isFile: () => true,
                isDirectory: () => false,
                isSymbolicLink: () => false,
              },
            });
          },
          // The loop calls this when it is left early, which is what closes a real directory.
          return: () => Promise.resolve({ done: true, value: undefined }),
        }),
      });
    },
  };
});

const { rm: realRemove } = await vi.importActual<typeof FileSystem>("node:fs/promises");

let base: string;
let workspace: string;
let repository: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "codemugs-stage-failure-"));
  workspace = join(base, "workspace");
  repository = join(base, "repository");
  await mkdir(workspace);
  await mkdir(repository);
  await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
});

afterEach(() => {
  failing.writeRepositoryFile = undefined;
  failing.remove = undefined;
  failing.endlessDirectory = undefined;
});

afterAll(async () => {
  await realRemove(base, { recursive: true, force: true });
});

const leftBehind = async (): Promise<string[]> =>
  (await readdir(workspace)).filter((name) => name.startsWith("analysis-"));

/** Removes what a test left because it made the removal fail. */
async function clearWorkspace(): Promise<void> {
  for (const name of await leftBehind()) {
    await realRemove(join(workspace, name), { recursive: true, force: true });
  }
}

describe("stageAnalysis, when the disk fails", () => {
  it("gives a code and not the system's error, when the disk is full, and leaves nothing behind", async () => {
    failing.writeRepositoryFile = Object.assign(
      new Error("ENOSPC: no space left on device, write '/secret/customer/path'"),
      { code: "ENOSPC" },
    );
    const error = await stageAnalysis({ repository, workspaceRoot: workspace }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AnalysisError);
    expect((error as AnalysisError).code).toBe("sandbox_failed");
    expect((error as AnalysisError).message).not.toMatch(/ENOSPC|secret|customer/);
    expect(await leftBehind()).toEqual([]);
  });

  it("gives a code when the workspace cannot be written to at all", async () => {
    await expect(
      stageAnalysis({ repository, workspaceRoot: join(base, "no", "such", "workspace") }),
    ).rejects.toMatchObject({ code: "sandbox_failed" });
  });

  it("stops listing a directory at the budget, and does not list the rest of it", async () => {
    failing.endlessDirectory = { yielded: 0 };
    await expect(
      stageAnalysis({ repository, workspaceRoot: workspace, limits: { maxEntries: 1_000 } }),
    ).rejects.toMatchObject({ code: "repository_too_large" });
    // One more than the budget is read, to find that it is over, and no more.
    expect(failing.endlessDirectory.yielded).toBe(1_001);
    expect(await leftBehind()).toEqual([]);
  });
});

describe("a working copy that cannot be removed", () => {
  const stuck = Object.assign(new Error("EBUSY: resource busy, rmdir '/secret/customer/path'"), {
    code: "EBUSY",
  });

  it("is `cleanup_failed`, when the staging that it was made for failed, and not the failure", async () => {
    failing.writeRepositoryFile = new Error("disk full");
    failing.remove = stuck;
    const error = await stageAnalysis({ repository, workspaceRoot: workspace }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AnalysisError);
    expect((error as AnalysisError).code).toBe("cleanup_failed");
    expect((error as AnalysisError).message).not.toMatch(/EBUSY|secret|customer/);
    failing.remove = undefined;
    await clearWorkspace();
  });

  it("is `cleanup_failed`, when it is removed by the caller", async () => {
    const staged = await stageAnalysis({ repository, workspaceRoot: workspace });
    failing.remove = stuck;
    await expect(staged.cleanup()).rejects.toMatchObject({ code: "cleanup_failed" });
    failing.remove = undefined;
    // And it can be tried again.
    await staged.cleanup();
    expect(await leftBehind()).toEqual([]);
  });

  it("is `cleanup_failed` at the end of an analysis, whatever the analysis gave", async () => {
    const driver: SandboxDriver = {
      name: "fake",
      isolation: "gvisor",
      availability: () => Promise.resolve({ available: true }),
      run: () => {
        // The analysis fails, and the removal that follows fails too.
        failing.remove = stuck;
        return Promise.resolve({
          outcome: "exited",
          exitCode: 1,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 1,
        });
      },
    };
    const error = await analyseInSandbox({
      driver,
      workspaceRoot: workspace,
      image: `docker.io/library/node@sha256:${"a".repeat(64)}`,
      minimumIsolation: "gvisor",
      repository,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AnalysisError);
    expect((error as AnalysisError).code).toBe("cleanup_failed");
    failing.remove = undefined;
    await clearWorkspace();
  });
});
