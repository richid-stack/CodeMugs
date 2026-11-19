import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tarball } from "@codemugs/archive/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repositoryArchive } from "./test-harness.js";
import { startUnpacking } from "./unpack.js";

let base: string;
let counter = 0;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "codemugs-unpack-"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function root(): Promise<string> {
  counter += 1;
  const path = join(base, `r${String(counter)}`);
  await mkdir(path);
  return path;
}

describe("startUnpacking", () => {
  it("unpacks what it is given, says how much, and leaves nothing behind", async () => {
    const folder = await root();
    const unpacking = await startUnpacking(folder);
    expect(await readdir(folder)).toHaveLength(1);
    await unpacking.sink(repositoryArchive());
    expect(await unpacking.end(true)).toEqual({
      ok: true,
      detail: "files 2, directories 1, content 36 bytes, copy removed",
    });
    expect(await readdir(folder)).toEqual([]);
  });

  it("takes the archive in pieces", async () => {
    const folder = await root();
    const unpacking = await startUnpacking(folder);
    const bytes = repositoryArchive();
    for (let at = 0; at < bytes.length; at += 7) await unpacking.sink(bytes.subarray(at, at + 7));
    expect((await unpacking.end(true))?.ok).toBe(true);
  });

  it("is not ok for an archive with no file in it", async () => {
    const unpacking = await startUnpacking(await root());
    await unpacking.sink(tarball([{ name: "top/", type: "directory" }]));
    expect(await unpacking.end(true)).toEqual({
      ok: false,
      detail: "files 0, directories 0, content 0 bytes, copy removed",
    });
  });

  it("throws what the unpacking throws, and says its code at the end", async () => {
    const folder = await root();
    const unpacking = await startUnpacking(folder);
    await expect(
      unpacking.sink(Buffer.from("this is not gzip at all, it is text")),
    ).rejects.toThrow();
    expect(await unpacking.end(false)).toEqual({ ok: false, detail: "corrupt" });
    expect(await readdir(folder)).toEqual([]);
  });

  it("says the code of a failure that is found when the archive ends", async () => {
    const folder = await root();
    const unpacking = await startUnpacking(folder);
    const bytes = repositoryArchive();
    await unpacking.sink(bytes.subarray(0, bytes.length - 10));
    expect(await unpacking.end(true)).toEqual({ ok: false, detail: "corrupt" });
    expect(await readdir(folder)).toEqual([]);
  });

  it("says nothing when the download failed for a reason of its own, and removes the copy", async () => {
    const folder = await root();
    const unpacking = await startUnpacking(folder);
    await unpacking.sink(repositoryArchive().subarray(0, 40));
    expect(await unpacking.end(false)).toBeUndefined();
    expect(await readdir(folder)).toEqual([]);
  });

  it("says nothing when it is ended before it was given anything", async () => {
    const folder = await root();
    const unpacking = await startUnpacking(folder);
    expect(await unpacking.end(false)).toBeUndefined();
    expect(await readdir(folder)).toEqual([]);
  });

  it("does not finish an unpacking that has failed, and says its first failure", async () => {
    const unpacking = await startUnpacking(await root());
    await expect(unpacking.sink(Buffer.from("not gzip"))).rejects.toThrow();
    // The download went on to its end as if nothing had been said to it.
    expect(await unpacking.end(true)).toEqual({ ok: false, detail: "corrupt" });
  });

  it("throws, and leaves nothing, when the directory cannot be made", async () => {
    await expect(startUnpacking(join(base, "does-not-exist"))).rejects.toThrow();
  });

  it("makes a directory for each unpacking, so that two do not meet", async () => {
    const folder = await root();
    const [one, two] = await Promise.all([startUnpacking(folder), startUnpacking(folder)]);
    expect(await readdir(folder)).toHaveLength(2);
    await Promise.all([one.sink(repositoryArchive()), two.sink(repositoryArchive())]);
    expect((await one.end(true))?.ok).toBe(true);
    expect((await two.end(true))?.ok).toBe(true);
    expect(await readdir(folder)).toEqual([]);
  });
});

/** What this process has open that is inside the folder: a file that an unpacking left open. */
async function openInside(folder: string): Promise<string[]> {
  const names = await readdir("/proc/self/fd");
  const targets = await Promise.all(
    names.map((name) => readlink(join("/proc/self/fd", name)).catch(() => "")),
  );
  return targets.filter((target) => target.startsWith(folder));
}

describe.skipIf(!existsSync("/proc/self/fd"))(
  "startUnpacking, a file that is half unpacked",
  () => {
    // Incompressible content, so that the first part of the archive holds the start of the file.
    const bytes = tarball([{ name: "top/big.bin", content: randomBytes(300_000) }]);

    it("is closed when the download fails", async () => {
      const folder = await root();
      const unpacking = await startUnpacking(folder);
      await unpacking.sink(bytes.subarray(0, 200_000));
      expect(await unpacking.end(false)).toBeUndefined();
      expect(await openInside(folder)).toEqual([]);
      expect(await readdir(folder)).toEqual([]);
    });
  },
);
