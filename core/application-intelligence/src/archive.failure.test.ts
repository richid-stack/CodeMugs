import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tarball } from "@codemugs/archive/testing";
import type * as FileSystem from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { analyseArchive, type AnalyseArchiveOptions } from "./archive.js";
import { AnalysisError } from "./errors.js";
import { exited, fakeDriver, IMAGE } from "./test-drivers.js";

/**
 * Failures of the disk that a test cannot make with a real one (a copy that cannot be removed, a
 * file that cannot be created) are made here by replacing two functions of `node:fs/promises` with
 * ones that fail, for the unpacked copy only, when a test says so, and that are the real ones
 * otherwise.
 */
const failing = vi.hoisted(() => ({
  removeCheckout: undefined as Error | undefined,
  createInCheckout: undefined as Error | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  const inCheckout = (path: unknown): boolean =>
    typeof path === "string" && path.includes("/checkout-");
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) =>
      failing.removeCheckout !== undefined && inCheckout(args[0])
        ? Promise.reject(failing.removeCheckout)
        : actual.rm(...args),
    open: (...args: Parameters<typeof actual.open>) =>
      failing.createInCheckout !== undefined && inCheckout(args[0])
        ? Promise.reject(failing.createInCheckout)
        : actual.open(...args),
  };
});

const { rm: realRemove } = await vi.importActual<typeof FileSystem>("node:fs/promises");

let base: string;
let counter = 0;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "codemugs-archive-failure-"));
});

afterEach(() => {
  failing.removeCheckout = undefined;
  failing.createInCheckout = undefined;
});

afterAll(async () => {
  await realRemove(base, { recursive: true, force: true });
});

async function options(
  analysis: Parameters<typeof fakeDriver>[0] = () => exited({ exitCode: 1 }),
): Promise<AnalyseArchiveOptions & { workspaceRoot: string }> {
  counter += 1;
  const workspaceRoot = join(base, `w${String(counter)}`);
  await mkdir(workspaceRoot);
  const bytes = tarball([{ name: "repo-abc/a.ts", content: "export const a = 1;\n" }]);
  return {
    driver: fakeDriver(analysis),
    workspaceRoot,
    image: IMAGE,
    minimumIsolation: "hardened-container",
    archive: async (sink) => {
      await sink(bytes);
    },
  };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AnalysisError) return error.code;
    throw error;
  }
  throw new Error("the analysis gave facts");
}

describe("analyseArchive, when the disk fails", () => {
  it("says that the copy could not be removed, and not what the system said", async () => {
    failing.removeCheckout = new Error("EBUSY: /secret/path/checkout-x");
    const settings = await options();
    try {
      await analyseArchive(settings);
      throw new Error("the analysis gave facts");
    } catch (error) {
      expect(error).toBeInstanceOf(AnalysisError);
      expect((error as AnalysisError).code).toBe("cleanup_failed");
      expect((error as AnalysisError).message).not.toContain("secret");
    }
    // The copy is still there, as the error says, and the staged one is not.
    failing.removeCheckout = undefined;
    const names = await readdir(settings.workspaceRoot);
    expect(names).toHaveLength(1);
    expect(names[0]?.startsWith("checkout-")).toBe(true);
  });

  it("says that the copy could not be removed even when the unpacking failed first", async () => {
    failing.removeCheckout = new Error("EBUSY");
    const settings = await options();
    const bytes = tarball([{ name: "/etc/passwd", content: "x" }]);
    expect(
      await code(
        analyseArchive({
          ...settings,
          archive: async (sink) => {
            await sink(bytes);
          },
        }),
      ),
    ).toBe("cleanup_failed");
  });

  it("says that the sandbox failed when a file cannot be created, and unpacks no more", async () => {
    failing.createInCheckout = new Error("ENOSPC: /secret/path");
    const settings = await options();
    expect(await code(analyseArchive(settings))).toBe("sandbox_failed");
    failing.createInCheckout = undefined;
    expect(await readdir(settings.workspaceRoot)).toEqual([]);
  });
});
