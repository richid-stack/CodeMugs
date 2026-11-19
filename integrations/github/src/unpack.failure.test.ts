import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Archive from "@codemugs/archive";
import { tarball } from "@codemugs/archive/testing";
import type * as FileSystem from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { repositoryArchive } from "./test-harness.js";
import { startUnpacking } from "./unpack.js";

/**
 * Failures that a test cannot make with a real disk (a copy that cannot be removed) and one that
 * is not worth a race (an unpacking that cannot start in a directory that was just made) are made
 * here by replacing `rm` and `createTarballExtractor` with ones that fail when a test says so.
 */
const failing = vi.hoisted(() => ({
  remove: undefined as Error | undefined,
  create: undefined as Error | undefined,
  /** Files that are made are real, and say that they could not be closed when they are. */
  closeFails: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) =>
      failing.remove === undefined ? actual.rm(...args) : Promise.reject(failing.remove),
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!failing.closeFails) return handle;
      // The file is closed, so that the test leaves nothing open, and then it says that it was not.
      return new Proxy(handle, {
        get(target, property) {
          if (property === "close") {
            return async () => {
              await target.close();
              throw new Error("EIO: /secret/path");
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    },
  };
});

vi.mock("@codemugs/archive", async (importOriginal) => {
  const actual = await importOriginal<typeof Archive>();
  return {
    ...actual,
    createTarballExtractor: (...args: Parameters<typeof actual.createTarballExtractor>) =>
      failing.create === undefined
        ? actual.createTarballExtractor(...args)
        : Promise.reject(failing.create),
  };
});

const { rm: realRemove } = await vi.importActual<typeof FileSystem>("node:fs/promises");

let base: string;
let counter = 0;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "codemugs-unpack-failure-"));
});

afterEach(() => {
  failing.remove = undefined;
  failing.create = undefined;
  failing.closeFails = false;
});

afterAll(async () => {
  await realRemove(base, { recursive: true, force: true });
});

async function root(): Promise<string> {
  counter += 1;
  const path = join(base, `r${String(counter)}`);
  await mkdir(path);
  return path;
}

describe("startUnpacking, when the disk fails", () => {
  it("says that the copy could not be removed, with what was unpacked", async () => {
    const unpacking = await startUnpacking(await root());
    await unpacking.sink(repositoryArchive());
    failing.remove = new Error("EBUSY: /secret/path");
    expect(await unpacking.end(true)).toEqual({
      ok: false,
      detail: "files 2, directories 1, content 36 bytes, the copy could not be removed",
    });
  });

  it("says that the copy could not be removed, with the failure that came first", async () => {
    const unpacking = await startUnpacking(await root());
    await expect(unpacking.sink(Buffer.from("not gzip"))).rejects.toThrow();
    failing.remove = new Error("EBUSY");
    expect(await unpacking.end(true)).toEqual({
      ok: false,
      detail: "corrupt, the copy could not be removed",
    });
  });

  it("says that the copy could not be removed when there is nothing else to say", async () => {
    const unpacking = await startUnpacking(await root());
    failing.remove = new Error("EBUSY");
    expect(await unpacking.end(false)).toEqual({
      ok: false,
      detail: "the copy could not be removed",
    });
  });

  it("removes the directory and throws when the unpacking cannot start", async () => {
    const folder = await root();
    failing.create = new Error("EACCES: /secret/path");
    await expect(startUnpacking(folder)).rejects.toThrow("EACCES");
    expect(await readdir(folder)).toEqual([]);
  });

  it("still removes the copy, and says nothing, when a half-unpacked file cannot be closed after a failed download", async () => {
    failing.closeFails = true;
    const folder = await root();
    const unpacking = await startUnpacking(folder);
    const bytes = tarball([{ name: "top/big.bin", content: randomBytes(300_000) }]);
    await unpacking.sink(bytes.subarray(0, 200_000));
    expect(await unpacking.end(false)).toBeUndefined();
    expect(await readdir(folder)).toEqual([]);
  });
});
