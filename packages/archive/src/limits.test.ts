import { describe, expect, it } from "vitest";
import { ARCHIVE_LIMITS, resolveLimits } from "./limits.js";
import type { ArchiveLimits } from "./limits.js";
import { gzip, paxRecord, tar, tarball, type FixtureEntry } from "./testing.js";
import { failureCode, place, tree, unpack } from "./test-support.js";
import { ArchiveError } from "./errors.js";

const ROOT = "owner-repo-0123abc";
const under = (name: string) => `${ROOT}/${name}`;

/** A limit is exactly where it says: the archive that reaches it is taken, and one more is not. */
async function boundary(
  limit: keyof ArchiveLimits,
  at: number,
  archive: (size: number) => Buffer,
): Promise<void> {
  const accepted = await place();
  await unpack(accepted, archive(at), { [limit]: at });
  const refused = await place();
  expect(await failureCode(unpack(refused, archive(at + 1), { [limit]: at }))).toBe("too_large");
}

describe("the limits", () => {
  it("are what the documentation says", () => {
    expect(ARCHIVE_LIMITS).toEqual({
      maxEntries: 200_000,
      maxContentBytes: 536_870_912,
      maxDecompressedBytes: 1_073_741_824,
      maxDepth: 100,
      maxPathBytes: 1_024,
      maxNameBytes: 255,
      maxTotalPathBytes: 33_554_432,
      maxExtendedHeaderBytes: 65_536,
    });
    expect(Object.isFrozen(ARCHIVE_LIMITS)).toBe(true);
  });

  it("can be lowered and not raised", () => {
    expect(resolveLimits({ maxEntries: 5 }).maxEntries).toBe(5);
    expect(resolveLimits({ maxEntries: 0 }).maxEntries).toBe(0);
    expect(resolveLimits({ maxEntries: ARCHIVE_LIMITS.maxEntries * 10 }).maxEntries).toBe(
      ARCHIVE_LIMITS.maxEntries,
    );
    expect(resolveLimits(undefined)).toEqual(ARCHIVE_LIMITS);
    for (const bad of [
      { other: 1 },
      { maxEntries: -1 },
      { maxEntries: 0.5 },
      { maxEntries: Number.NaN },
      { maxEntries: "1" },
    ]) {
      expect(() => resolveLimits(bad as never)).toThrow(RangeError);
    }
  });

  it("do not change the limits that were not named", () => {
    const limits = resolveLimits({ maxDepth: 3 });
    expect(limits).toEqual({ ...ARCHIVE_LIMITS, maxDepth: 3 });
  });

  it("stop the entries that a path implies, and the ones that are named", async () => {
    // Three directories and a file: four entries.
    const nested = (size: number): Buffer => {
      const entries: FixtureEntry[] = [];
      for (let index = 0; index < size - 4; index += 1)
        entries.push({ name: under(`f${String(index)}`), content: "x" });
      entries.push({ name: under("a/b/c/last"), content: "x" });
      return tarball(entries);
    };
    await boundary("maxEntries", 4, nested);
    await boundary("maxEntries", 50, nested);
  });

  it("count directories, links and files alike", async () => {
    const kinds = (size: number): Buffer =>
      tarball(
        Array.from({ length: size }, (_, index): FixtureEntry =>
          index % 3 === 0
            ? { name: under(`d${String(index)}/`), type: "directory" }
            : index % 3 === 1
              ? { name: under(`l${String(index)}`), type: "symlink", linkname: "x" }
              : { name: under(`f${String(index)}`), content: "x" },
        ),
      );
    await boundary("maxEntries", 9, kinds);
  });

  it("stop the bytes of content, the sum of all files and not one", async () => {
    const files = (size: number): Buffer =>
      tarball([
        { name: under("a"), content: "x".repeat(Math.floor(size / 2)) },
        { name: under("b"), content: "x".repeat(size - Math.floor(size / 2)) },
      ]);
    await boundary("maxContentBytes", 1_000, files);
    await boundary("maxContentBytes", 1, files);
  });

  it("stop the depth of directories, for a directory and for the file in the last one", async () => {
    const deep = (size: number): Buffer =>
      tarball([
        {
          name: "decoy/",
          type: "directory",
          pax: {
            path: under(
              `${Array.from({ length: size }, (_, index) => `d${String(index)}`).join("/")}/`,
            ),
          },
        },
      ]);
    await boundary("maxDepth", 100, deep);
    await boundary("maxDepth", 3, deep);
    const deepFile = (size: number): Buffer =>
      tarball([
        {
          name: "decoy",
          pax: {
            path: under(
              `${Array.from({ length: size }, (_, index) => `d${String(index)}`).join("/")}/file.txt`,
            ),
          },
          content: "x",
        },
      ]);
    await boundary("maxDepth", 100, deepFile);
    await boundary("maxDepth", 2, deepFile);
    // A file at the top has no directory above it.
    const top = await place();
    await unpack(top, tarball([{ name: under("file.txt"), content: "x" }]), { maxDepth: 0 });
  });

  it("stop the length of a path, in bytes and not in letters", async () => {
    const long = (size: number): Buffer => {
      // Names of at most 100 bytes, so that only the length of the whole path is at its limit.
      let path = ROOT;
      for (let left = size - ROOT.length; left > 0;) {
        const take = left > 101 ? 100 : left;
        path += `/${"p".repeat(take - 1)}`;
        left -= take;
      }
      return tarball([{ name: "decoy", pax: { path }, content: "x" }]);
    };
    await boundary("maxPathBytes", 1_024, long);
    await boundary("maxPathBytes", 300, long);
    const letters = await place();
    // 150 letters of 2 bytes each are 300 bytes, which is over a limit of 200 bytes.
    expect(
      await failureCode(
        unpack(
          letters,
          tarball([{ name: "decoy", pax: { path: `${ROOT}/${"é".repeat(150)}` }, content: "x" }]),
          { maxPathBytes: 200 },
        ),
      ),
    ).toBe("too_large");
  });

  it("stop the length of one name, in bytes", async () => {
    const named = (size: number): Buffer =>
      tarball([{ name: "decoy", pax: { path: `${ROOT}/${"n".repeat(size)}` }, content: "x" }]);
    await boundary("maxNameBytes", 255, named);
    await boundary("maxNameBytes", 20, named);
    const multibyte = await place();
    expect(
      await failureCode(
        unpack(
          multibyte,
          tarball([{ name: "decoy", pax: { path: `${ROOT}/${"é".repeat(11)}` }, content: "x" }]),
          { maxNameBytes: 20 },
        ),
      ),
    ).toBe("too_large");
  });

  it("stop the memory that the paths take, including the directories that a path implies", async () => {
    // Paths "x/1", "x/2" ... : the directory "x" is 1 byte and each file is 3 bytes.
    // The directory "x" is 1 byte, and each of 20 files is "x/" and a name of 3 bytes: 101 in all.
    // One byte more is the last name at 4 bytes.
    const paths = (size: number): Buffer => {
      const entries: FixtureEntry[] = [];
      for (let index = 0; index < 20; index += 1) {
        const width = index === 19 ? 3 + (size - 101) : 3;
        entries.push({ name: under(`x/${String(index).padStart(width, "0")}`), content: "x" });
      }
      return tarball(entries);
    };
    await boundary("maxTotalPathBytes", 101, paths);
  });

  it("count the memory of paths in bytes and not in letters", async () => {
    // "é" is two bytes: the directory is 2 and the file "é/é" is 5, which is 7 in all, and 3 letters.
    const archive = tarball([{ name: under("é/é"), content: "x" }]);
    await unpack(await place(), archive, { maxTotalPathBytes: 7 });
    expect(await failureCode(unpack(await place(), archive, { maxTotalPathBytes: 6 }))).toBe(
      "too_large",
    );
  });

  it("stop an extended header, at its size and not its padded size", async () => {
    // One record of exactly `size` bytes: its digits, " a=", the value and a newline.
    const extended = (size: number): Buffer =>
      tarball([
        {
          name: under("a"),
          rawPax: paxRecord("a", "k".repeat(size - String(size).length - 4)),
          content: "x",
        },
      ]);
    await boundary("maxExtendedHeaderBytes", 100, extended);
    await boundary("maxExtendedHeaderBytes", 513, extended);
  });

  it("stop what the gzip stream expands to, headers and padding and the end marker included", async () => {
    const plain = tar([{ name: under("a"), content: "x".repeat(700) }]);
    const accepted = await place();
    await unpack(accepted, gzip(plain), { maxDecompressedBytes: plain.length });
    expect(
      await failureCode(
        unpack(await place(), gzip(plain), { maxDecompressedBytes: plain.length - 1 }),
      ),
    ).toBe("too_large");
  });

  it("with a limit of nothing, take an empty archive and refuse anything that makes something", async () => {
    const zero = { maxEntries: 0, maxContentBytes: 0, maxPathBytes: 0 };
    const where = await place();
    await unpack(where, tarball([{ name: `${ROOT}/`, type: "directory" }]), { maxEntries: 0 });
    expect(
      await failureCode(unpack(await place(), tarball([{ name: under("a"), content: "" }]), zero)),
    ).toBe("too_large");
    expect(await tree(where.dest)).toEqual([]);
    expect(new ArchiveError("too_large").code).toBe("too_large");
  });
});
