import { describe, expect, it } from "vitest";
import type { ArchiveErrorCode } from "./errors.js";
import { gzip, tar, tarball, type FixtureEntry } from "./testing.js";
import {
  everythingOf,
  expectNothingOutside,
  failure,
  place,
  tree,
  unpack,
} from "./test-support.js";

const ROOT = "owner-repo-0123abc";
const MARK = "MARKER-7f3a9c";
const under = (name: string) => `${ROOT}/${name}`;

/**
 * An archive that is written to hurt: each must be refused with its code, must make nothing outside
 * the destination, must leave what is outside as it was, must make no link that points anywhere but
 * at itself, and must not put a name that it holds in the error.
 */
async function refused(entries: readonly FixtureEntry[], code: ArchiveErrorCode): Promise<void> {
  const where = await place();
  const error = await failure(unpack(where, tarball(entries)));
  expect(error.code).toBe(code);
  expect(everythingOf(error)).not.toContain(MARK);
  expect(await expectNothingOutside(where)).toEqual([]);
  for (const line of await tree(where.dest)) {
    if (line.startsWith("l ")) expect(line.endsWith(" -> .")).toBe(true);
  }
}

describe("a path that leaves the destination, or is not a path", () => {
  it.each([
    ["dots up out of the top directory", [{ name: `${ROOT}/../../${MARK}/x`, content: "x" }]],
    ["dots up, from below", [{ name: under(`a/../../${MARK}`), content: "x" }]],
    [
      "dots up to a directory of the destination",
      [{ name: under("a/.."), type: "directory" as const }],
    ],
    ["a first name of dots", [{ name: `../${MARK}`, content: "x" }]],
    [
      "the top directory's parent as a directory",
      [{ name: `${ROOT}/..`, type: "directory" as const }],
    ],
    ["an absolute path", [{ name: `/etc/${MARK}`, content: "x" }]],
    ["two slashes at the start", [{ name: `//${MARK}`, content: "x" }]],
    ["an empty name in the middle", [{ name: under(`a//${MARK}`), content: "x" }]],
    ["a dot as a name", [{ name: under(`./${MARK}`), content: "x" }]],
    ["a dot as a name, below", [{ name: under(`a/./${MARK}`), content: "x" }]],
    ["a slash at the end of a file", [{ name: under(`${MARK}/`), content: "x" }]],
    [
      "an entry under another top directory",
      [
        { name: under("a"), content: "x" },
        { name: `other/${MARK}`, content: "x" },
      ],
    ],
    ["the top directory as a file", [{ name: ROOT, content: "x" }]],
    ["the top directory as a link", [{ name: ROOT, type: "symlink" as const, linkname: "/etc" }]],
    [
      "a path that is not UTF-8",
      [
        {
          name: Buffer.concat([Buffer.from(`${ROOT}/`), Buffer.from([0xff, 0xfe, 0x41])]),
          content: "x",
        },
      ],
    ],
    [
      "a path in an extended header that dots up",
      [{ name: "decoy", pax: { path: `${ROOT}/../${MARK}` }, content: "x" }],
    ],
    [
      "a directory in an extended header that dots up",
      [{ name: "decoy/", type: "directory" as const, pax: { path: `${ROOT}/a/../../${MARK}/` } }],
    ],
    [
      "an absolute path in an extended header",
      [{ name: "decoy", pax: { path: `/${MARK}` }, content: "x" }],
    ],
  ])("refuses %s", async (_label, entries) => {
    await refused(entries, "unsafe_path");
  });
});

describe("a name that is used twice, or used through something that the archive made", () => {
  const link = (name: string) => ({
    name: under(name),
    type: "symlink" as const,
    linkname: `/tmp/${MARK}`,
  });
  const file = (name: string) => ({ name: under(name), content: "x" });
  const dir = (name: string) => ({ name: under(`${name}/`), type: "directory" as const });

  it.each([
    ["a file through a link", [link("l"), file(`l/${MARK}`)]],
    ["a file two levels below a link", [link("l"), file(`l/a/${MARK}`)]],
    ["a directory through a link", [link("l"), dir(`l/${MARK}`)]],
    ["a link through a link", [link("l"), link(`l/${MARK}`)]],
    ["a file below a file", [file("a"), file(`a/${MARK}`)]],
    ["a file two levels below a file", [file("a"), file(`a/b/${MARK}`)]],
    ["a file twice", [file("a"), file("a")]],
    ["a link twice", [link("a"), link("a")]],
    ["a file, then a directory of its name", [file("a"), dir("a")]],
    ["a directory, then a file of its name", [dir("a"), file("a")]],
    [
      "a directory that is made when a file is below it, then a file of its name",
      [file("a/b"), file("a")],
    ],
    ["a link, then a directory of its name", [link("a"), dir("a")]],
    ["a directory, then a link of its name", [dir("a"), link("a")]],
    ["a file, then a link of its name", [file("a"), link("a")]],
    ["a link, then a file of its name", [link("a"), file("a")]],
  ])("refuses %s", async (_label, entries) => {
    await refused(entries, "unsafe_path");
  });

  it("does not write through a link to a directory outside, whatever it names", async () => {
    const where = await place();
    const entries = [
      { name: under("l"), type: "symlink" as const, linkname: where.outside },
      { name: under("l/sentinel.txt"), content: "overwritten" },
    ];
    const error = await failure(unpack(where, tarball(entries)));
    expect(error.code).toBe("unsafe_path");
    expect(await expectNothingOutside(where)).toEqual([]);
  });

  it("takes a directory twice, which is harmless", async () => {
    const where = await place();
    await unpack(
      where,
      tarball([
        { name: under("a/"), type: "directory" },
        { name: under("a/"), type: "directory" },
      ]),
    );
    expect(await tree(where.dest)).toEqual(["d a"]);
  });
});

describe("an entry of a kind that is not accepted", () => {
  it.each([
    [
      "a hard link to a file outside",
      { name: under(MARK), type: "hardlink" as const, linkname: "../../outside/sentinel.txt" },
    ],
    ["a character device", { name: under(MARK), type: "character" as const }],
    ["a block device", { name: under(MARK), type: "block" as const }],
    ["a pipe", { name: under(MARK), type: "fifo" as const }],
    ["a contiguous file", { name: under(MARK), type: "contiguous" as const, content: "x" }],
    [
      "a long name of GNU tar",
      { name: "././@LongLink", type: "gnu-long-name" as const, content: `${ROOT}/${MARK}\0` },
    ],
    [
      "a long link name of GNU tar",
      { name: "././@LongLink", type: "gnu-long-link" as const, content: `${MARK}\0` },
    ],
    ["a sparse file", { name: under(MARK), type: "sparse" as const, content: "x" }],
    ["a type that does not exist", { name: under(MARK), type: 0x5a, content: "x" }],
    ["a type that is a digit", { name: under(MARK), type: 0x39, content: "x" }],
  ])("refuses %s", async (_label, entry) => {
    await refused([{ name: under("first"), content: "ok" }, entry], "unsupported_entry");
  });

  it("refuses it before anything after it is made", async () => {
    const where = await place();
    const error = await failure(
      unpack(
        where,
        tarball([
          { name: under("a"), type: "hardlink", linkname: "b" },
          { name: under("after"), content: "x" },
        ]),
      ),
    );
    expect(error.code).toBe("unsupported_entry");
    expect(await tree(where.dest)).toEqual([]);
  });
});

describe("sizes and counts that a header can claim", () => {
  it("refuses a file that is larger than the limit before it writes a byte of it", async () => {
    const where = await place();
    const error = await failure(
      unpack(where, tarball([{ name: under("big"), sizeInHeader: 600 * 1_048_576 }])),
    );
    expect(error.code).toBe("too_large");
    expect(await tree(where.dest)).toEqual([]);
  });

  it("refuses a size in base 256, which is what a file of 8 GiB needs", async () => {
    const size = Buffer.alloc(12);
    size.writeUInt8(0x80, 0);
    size.writeUInt32BE(1, 8);
    await refused([{ name: under(MARK), raw: { size }, content: "x" }], "too_large");
  });

  it.each([
    ["a terabyte", "1099511627776", "too_large"],
    ["a number that is not safe in a double", "9007199254740993", "too_large"],
    ["a number of 17 digits", "12345678901234567", "corrupt"],
  ])("refuses a size of %s in an extended header", async (_label, size, code) => {
    await refused([{ name: under(MARK), pax: { size }, content: "x" }], code as ArchiveErrorCode);
  });

  it("refuses an extended header that is over its limit, however it is padded", async () => {
    const body = Buffer.alloc(70 * 1_024, 0x61);
    await refused([{ name: under(MARK), rawPax: body, content: "x" }], "too_large");
  });

  it("refuses an extended header that is a global one over its limit", async () => {
    const where = await place();
    const big = Buffer.alloc(70 * 1_024, 0x20);
    const header = tar([{ name: "pax_global_header", type: 0x67, sizeInHeader: big.length }], {
      endBlocks: 0,
    });
    const error = await failure(unpack(where, gzip(Buffer.concat([header, big]))));
    expect(error.code).toBe("too_large");
  });

  it("refuses a gzip stream that expands to more than the limit, and stops reading at the limit", async () => {
    const where = await place();
    const bomb = gzip(Buffer.alloc(64 * 1_048_576));
    expect(bomb.length).toBeLessThan(100_000);
    const limit = 1_048_576;
    const { createTarballExtractor } = await import("./extract.js");
    const extractor = await createTarballExtractor({
      destination: where.dest,
      limits: { maxDecompressedBytes: limit },
    });
    const error = await failure(extractor.write(bomb).then(() => extractor.finish()));
    expect(error.code).toBe("too_large");
    // It stopped within a piece of the limit and did not read the 64 MiB.
    expect(extractor.progress().decompressedBytes).toBeLessThanOrEqual(limit + 4 * 65_536);
    expect(await tree(where.dest)).toEqual([]);
  });

  it("refuses a valid archive whose zeros after the end are more than the limit", async () => {
    const where = await place();
    const bytes = gzip(
      Buffer.concat([tar([{ name: under("a"), content: "a" }]), Buffer.alloc(8 * 1_048_576)]),
    );
    expect(await failure(unpack(where, bytes, { maxDecompressedBytes: 1_048_576 }))).toMatchObject({
      code: "too_large",
    });
  });

  it("refuses a file whose header says less than what follows, and one that says more", async () => {
    const where = await place();
    const lessThan = tarball([{ name: under("a"), content: "x".repeat(2_000), sizeInHeader: 10 }]);
    expect((await failure(unpack(where, lessThan))).code).toBe("corrupt");
    const more = await place();
    const moreThan = tarball([{ name: under("a"), content: "x".repeat(10), sizeInHeader: 5_000 }], {
      endBlocks: 0,
    });
    expect((await failure(unpack(more, moreThan))).code).toBe("corrupt");
  });
});

describe("what an error says", () => {
  it("holds no name, no size and no path from the archive, in any form that it can be seen", async () => {
    const where = await place();
    const error = await failure(
      unpack(where, tarball([{ name: under(`${MARK}/../../${MARK}`), content: MARK }])),
    );
    const seen = everythingOf(error);
    expect(seen).not.toContain(MARK);
    expect(seen).not.toContain(where.dest);
    expect(seen).not.toContain(ROOT);
  });
});
