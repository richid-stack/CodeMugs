import { appendFile, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveLimits } from "./limits.js";
import { directorySource, isUsablePath, memorySource } from "./source.js";

const limits = resolveLimits();
let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "codemugs-source-"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

let counter = 0;
/** A fresh repository on disk, made of `files` (a path and its text). */
async function repository(files: Record<string, string>): Promise<string> {
  counter += 1;
  const root = join(base, `repo-${String(counter)}`);
  await mkdir(root, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, text);
  }
  return root;
}

const pathsOf = async (
  root: string,
  override?: Parameters<typeof resolveLimits>[0],
): Promise<string[]> =>
  (await directorySource(root).list(resolveLimits(override))).files.map((file) => file.path);

describe("directorySource", () => {
  it("lists the files in a fixed order, with their size", async () => {
    const root = await repository({
      "b.ts": "bb",
      "a.ts": "a",
      "z/y.ts": "yyy",
      "z/a/b.ts": "",
      "A.ts": "AA",
    });
    const listing = await directorySource(root).list(limits);
    expect(listing.files.map((file) => `${file.path}:${String(file.bytes)}`)).toEqual([
      "A.ts:2",
      "a.ts:1",
      "b.ts:2",
      "z/a/b.ts:0",
      "z/y.ts:3",
    ]);
    expect(listing.seen).toBe(5);
    expect(listing.depthExceeded).toBe(false);
  });

  it("gives the same answer however the directory was filled", async () => {
    const one = await repository({ "a.ts": "1", "b.ts": "2", "c/d.ts": "3" });
    const two = await repository({ "c/d.ts": "3", "b.ts": "2", "a.ts": "1" });
    expect(await pathsOf(one)).toEqual(await pathsOf(two));
  });

  it("reads a file", async () => {
    const root = await repository({ "a.ts": "hello" });
    const [file] = (await directorySource(root).list(limits)).files;
    expect((await file?.read())?.toString()).toBe("hello");
  });

  it("reads a file that is exactly as large as the limit, whole", async () => {
    const root = await repository({ "exact.txt": "x".repeat(100) });
    const [file] = (await directorySource(root).list(resolveLimits({ maxFileBytes: 100 }))).files;
    expect((await file?.read())?.length).toBe(100);
  });

  it("reads no more than a byte beyond the size that a file was listed with, when it grows", async () => {
    const root = await repository({ "grows.txt": "0123456789" });
    const [file] = (await directorySource(root).list(limits)).files;
    await appendFile(join(root, "grows.txt"), "x".repeat(5000));
    const text = (await file?.read())?.toString();
    expect(text).toBe("0123456789x");
  });

  it("orders names the same way whatever the file system or the operating system gives them in", async () => {
    // By the bytes of UTF-8 the fullwidth tilde comes before the emoji, and by the units of UTF-16,
    // which are what JavaScript compares and what `memorySource` sorts by, the emoji comes first.
    // A directory read hands them over in the order of the system that it runs on.
    const names = ["\uFF5E.ts", "\u{1F600}.ts", "b.ts", "B.ts", "a.ts"];
    const root = await repository(Object.fromEntries(names.map((name) => [name, ""])));
    const listed = await pathsOf(root);
    expect(listed).toEqual([...names].sort());
    expect(listed.slice(-2)).toEqual(["\u{1F600}.ts", "\uFF5E.ts"]);
    const inMemory = await memorySource(Object.fromEntries(names.map((name) => [name, ""]))).list(
      limits,
    );
    expect(inMemory.files.map((file) => file.path)).toEqual(listed);
  });

  it("reads no more of a file than the limit, whatever the file grows to", async () => {
    const root = await repository({ "big.txt": "x".repeat(5000) });
    const [file] = (await directorySource(root).list(resolveLimits({ maxFileBytes: 100 }))).files;
    expect((await file?.read())?.length).toBe(100);
  });

  it("does not follow a symbolic link, to a file or to a directory, and counts it", async () => {
    const outside = await repository({ "secret.txt": "outside", "dir/inner.ts": "x" });
    const root = await repository({ "real.ts": "r" });
    await symlink(join(outside, "secret.txt"), join(root, "link-to-file.txt"));
    await symlink(join(outside, "dir"), join(root, "link-to-dir"));
    await symlink("real.ts", join(root, "link-inside.ts"));
    await symlink("missing-target", join(root, "dangling"));
    const listing = await directorySource(root).list(limits);
    expect(listing.files.map((file) => file.path)).toEqual(["real.ts"]);
    expect(listing.skips.symlink).toBe(4);
  });

  it("does not list the directories that are never the repository's own, and counts them", async () => {
    const root = await repository({
      "a.ts": "a",
      "node_modules/pkg/index.js": "x",
      ".git/config": "x",
      "dist/a.js": "x",
      "build/a.js": "x",
      "coverage/a.js": "x",
      ".next/a.js": "x",
      ".turbo/a.js": "x",
      ".cache/a.js": "x",
      ".codemugs/a.js": "x",
      "src/node_modules/pkg/index.js": "x",
    });
    const listing = await directorySource(root).list(limits);
    expect(listing.files.map((file) => file.path)).toEqual(["a.ts"]);
    expect(listing.skips.ignoredDirectory).toBe(10);
    expect(listing.seen).toBe(1);
  });

  it("does not list a file whose name a fact cannot carry, and counts it", async () => {
    const root = await repository({
      "ok.ts": "x",
      "new\nline.ts": "x",
      "tab\tname.ts": "x",
      "back\\slash.ts": "x",
    });
    const listing = await directorySource(root).list(limits);
    expect(listing.files.map((file) => file.path)).toEqual(["ok.ts"]);
    expect(listing.skips.badName).toBe(3);
    expect(listing.seen).toBe(1);
  });

  it("does not go into a directory whose name a fact cannot carry", async () => {
    const root = await repository({ "ok.ts": "x", "bad\ndir/one.ts": "x", "bad\ndir/two.ts": "x" });
    const listing = await directorySource(root).list(limits);
    expect(listing.files.map((file) => file.path)).toEqual(["ok.ts"]);
    // The directory is counted once, and its files are not counted at all, because it was not entered.
    expect(listing.skips.badName).toBe(1);
  });

  it("does not list a name that is longer than a fact can carry", async () => {
    const root = await repository({
      "ok.ts": "x",
      [`${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(100)}/${"d".repeat(100)}/${"e".repeat(100)}/${"g".repeat(100)}/f.ts`]:
        "x",
    });
    const listing = await directorySource(root).list(limits);
    expect(listing.files.map((file) => file.path)).toEqual(["ok.ts"]);
    expect(listing.skips.badName).toBe(1);
  });

  it("stops at the depth that it is allowed, and says so", async () => {
    const root = await repository({
      "a.ts": "x",
      "d1/b.ts": "x",
      "d1/d2/c.ts": "x",
      "d1/d2/d3/d.ts": "x",
    });
    const listing = await directorySource(root).list(resolveLimits({ maxDirectoryDepth: 2 }));
    expect(listing.files.map((file) => file.path)).toEqual(["a.ts", "d1/b.ts", "d1/d2/c.ts"]);
    expect(listing.depthExceeded).toBe(true);
    const enough = await directorySource(root).list(resolveLimits({ maxDirectoryDepth: 3 }));
    expect(enough.depthExceeded).toBe(false);
    expect(enough.files).toHaveLength(4);
  });

  it("lists no more files than the limit, and counts the rest as seen", async () => {
    const root = await repository({ "a.ts": "x", "b.ts": "x", "c.ts": "x", "d.ts": "x" });
    const listing = await directorySource(root).list(resolveLimits({ maxFiles: 2 }));
    expect(listing.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(listing.seen).toBe(4);
  });

  it("lists an empty directory as no files", async () => {
    const root = await repository({});
    expect(await pathsOf(root)).toEqual([]);
  });

  it("refuses a root that cannot be read, which is not an empty repository", async () => {
    await expect(directorySource(join(base, "does-not-exist")).list(limits)).rejects.toThrow(
      "the repository cannot be read",
    );
    const file = join(base, "a-file");
    await writeFile(file, "x");
    await expect(directorySource(file).list(limits)).rejects.toThrow(
      "the repository cannot be read",
    );
  });

  // The user that is root reads every directory, so there is nothing to count for it.
  it.skipIf(process.getuid?.() === 0)(
    "counts a directory below the root that it cannot read, and goes on",
    async () => {
      const root = await repository({ "a.ts": "x", "locked/b.ts": "x" });
      await chmod(join(root, "locked"), 0o000);
      try {
        const listing = await directorySource(root).list(limits);
        expect(listing.files.map((file) => file.path)).toEqual(["a.ts"]);
        expect(listing.skips.unreadable).toBe(1);
      } finally {
        await chmod(join(root, "locked"), 0o755);
      }
    },
  );
});

describe("memorySource", () => {
  it("lists the paths in a fixed order, with their size in bytes, not in characters", async () => {
    const listing = await memorySource({ "b.ts": "é", "a.ts": "x" }).list(limits);
    expect(listing.files.map((file) => `${file.path}:${String(file.bytes)}`)).toEqual([
      "a.ts:1",
      "b.ts:2",
    ]);
    expect((await listing.files[1]?.read())?.toString()).toBe("é");
  });

  it("leaves out a name that cannot be carried, and lists no more than the limit", async () => {
    const listing = await memorySource({ "a.ts": "", "b\n.ts": "", "c.ts": "", "d.ts": "" }).list(
      resolveLimits({ maxFiles: 2 }),
    );
    expect(listing.files.map((file) => file.path)).toEqual(["a.ts", "c.ts"]);
    expect(listing.seen).toBe(3);
    expect(listing.skips.badName).toBe(1);
  });
});

describe("isUsablePath", () => {
  it("takes a name that a fact can carry", () => {
    expect(isUsablePath("src/a b.ts", limits)).toBe(true);
    expect(isUsablePath("ünï/файл", limits)).toBe(true);
    expect(isUsablePath("a".repeat(limits.maxPathLength), limits)).toBe(true);
  });

  it("refuses an empty name, a long one, a backslash, and a control character", () => {
    expect(isUsablePath("", limits)).toBe(false);
    expect(isUsablePath("a".repeat(limits.maxPathLength + 1), limits)).toBe(false);
    expect(isUsablePath("a\\b", limits)).toBe(false);
    for (const code of [0, 9, 10, 13, 27, 31, 127, 133, 159, 0x2028, 0x2029]) {
      expect(isUsablePath(`a${String.fromCharCode(code)}b`, limits), String(code)).toBe(false);
    }
  });
});
