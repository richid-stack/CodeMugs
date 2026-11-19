import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ArchiveErrorCode } from "./errors.js";
import {
  gzip,
  globalHeader,
  header,
  paxRecord,
  tar,
  tarball,
  type FixtureEntry,
} from "./testing.js";
import { contents, failureCode, place, tree, unpack } from "./test-support.js";
import { gzipSync } from "node:zlib";

const ROOT = "owner-repo-0123abc";
const under = (name: string) => `${ROOT}/${name}`;
const one: FixtureEntry = { name: under("a.txt"), content: "a" };

async function codeOf(bytes: Buffer | readonly Buffer[]): Promise<ArchiveErrorCode> {
  return failureCode(unpack(await place(), bytes));
}

describe("bytes that are not a gzip stream", () => {
  it.each([
    ["nothing", Buffer.alloc(0)],
    ["a word", Buffer.from("not gzip")],
    ["a page of HTML", Buffer.from("<html><body>Not Found</body></html>")],
    ["a tar archive that is not compressed", tar([one])],
    ["random bytes", randomBytes(4_096)],
    ["one byte of the gzip magic", Buffer.from([0x1f])],
    ["a gzip header and nothing else", Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3])],
  ])("refuses %s", async (_label, bytes) => {
    expect(await codeOf(bytes)).toBe("corrupt");
  });

  it("refuses gzip of bytes that are not a tar archive", async () => {
    expect(
      await codeOf(gzip(Buffer.from("just some text, not an archive at all".repeat(40)))),
    ).toBe("corrupt");
    expect(await codeOf(gzip(randomBytes(2_048)))).toBe("corrupt");
  });

  it("refuses a stream that has been cut short, wherever it is cut", async () => {
    const bytes = tarball([{ name: under("big.txt"), content: "content ".repeat(300) }, one]);
    for (const cut of [
      1,
      5,
      10,
      20,
      Math.floor(bytes.length / 2),
      bytes.length - 9,
      bytes.length - 8,
      bytes.length - 1,
    ]) {
      expect(await codeOf(bytes.subarray(0, cut))).toBe("corrupt");
    }
  });

  it("refuses a stream whose check has been altered", async () => {
    const bytes = Buffer.from(tarball([one]));
    bytes[bytes.length - 8] = (bytes[bytes.length - 8] ?? 0) ^ 0xff;
    expect(await codeOf(bytes)).toBe("corrupt");
    const length = Buffer.from(tarball([one]));
    length[length.length - 1] = (length[length.length - 1] ?? 0) ^ 0xff;
    expect(await codeOf(length)).toBe("corrupt");
  });

  it("refuses text after the gzip stream, and takes zeros after it, which gzip allows as padding", async () => {
    const good = tarball([one]);
    expect(await codeOf(Buffer.concat([good, Buffer.from("trailing text that is not gzip")]))).toBe(
      "corrupt",
    );
    expect(
      await codeOf(Buffer.concat([good, Buffer.from([0x1f, 0x8b, 1, 2, 3, 4, 5, 6, 7, 8])])),
    ).toBe("corrupt");
    const where = await place();
    await unpack(where, Buffer.concat([good, Buffer.alloc(100)]));
    expect(await tree(where.dest)).toEqual(["f a.txt"]);
  });

  it("refuses a stream with a byte of its compressed data changed", async () => {
    const bytes = Buffer.from(tarball([{ name: under("a"), content: "data ".repeat(200) }]));
    bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] ?? 0) ^ 0x55;
    expect(await codeOf(bytes)).toBe("corrupt");
  });

  it("takes an archive that is in two gzip members, as gzip says it may be", async () => {
    const bytes = tar([one, { name: under("b.txt"), content: "b" }]);
    const where = await place();
    await unpack(where, [gzipSync(bytes.subarray(0, 1_024)), gzipSync(bytes.subarray(1_024))]);
    expect(await tree(where.dest)).toEqual(["f a.txt", "f b.txt"]);
  });
});

describe("a tar archive that is not well formed", () => {
  it.each([
    ["a checksum that does not add up", { raw: { checksum: Buffer.from("0000001\0") } }],
    ["a checksum that is not a number", { raw: { checksum: Buffer.from("abcdefg\0") } }],
    ["a checksum that is empty", { raw: { checksum: Buffer.alloc(8) } }],
    ["no magic", { raw: { magic: Buffer.alloc(8) } }],
    ["the magic of another format", { raw: { magic: Buffer.from("ustar!00") } }],
    ["a size that ends in letters", { raw: { size: Buffer.from("00000012abc\0") } }],
    ["a size that is empty", { raw: { size: Buffer.alloc(12) } }],
    ["a size that is all spaces", { raw: { size: Buffer.alloc(12, 0x20) } }],
    ["a size with a digit that is not octal", { raw: { size: Buffer.from("00000000089\0") } }],
    ["a size with text in the middle", { raw: { size: Buffer.from("00001 2\0\0\0\0\0") } }],
  ] as const)("refuses %s", async (_label, change) => {
    // No content, so that a size that is read wrongly is not caught by what follows it.
    expect(await codeOf(tarball([{ ...one, content: "", ...change }]))).toBe("corrupt");
  });

  it("takes a number with leading spaces and trailing spaces and NULs, as tar writes them", async () => {
    const where = await place();
    await unpack(where, tarball([{ ...one, raw: { size: Buffer.from("         1 \0") } }]));
    expect(await contents(where.dest, "a.txt")).toBe("a");
  });

  it("takes the magic of old GNU tar", async () => {
    const where = await place();
    await unpack(where, tarball([{ ...one, raw: { magic: Buffer.from("ustar  \0") } }]));
    expect(await contents(where.dest, "a.txt")).toBe("a");
  });

  it("does not read the prefix of a header that is not POSIX, where those bytes are something else", async () => {
    const block = header({
      name: under("a.txt"),
      flag: 0x30,
      size: 1,
      raw: { magic: Buffer.from("ustar  \0") },
    });
    block.write("GARBAGE-PREFIX", 345);
    let sum = 0;
    block.fill(0x20, 148, 156);
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    const where = await place();
    await unpack(
      where,
      gzip(
        Buffer.concat([
          block,
          Buffer.concat([Buffer.from("a"), Buffer.alloc(511)]),
          Buffer.alloc(1_024),
        ]),
      ),
    );
    expect(await tree(where.dest)).toEqual(["f a.txt"]);
  });

  it("refuses a header with no name", async () => {
    expect(await codeOf(tarball([{ name: "", content: "x" }]))).toBe("corrupt");
  });

  it.each([
    [
      "a directory with a size",
      { name: under("d/"), type: "directory", sizeInHeader: 5, content: "hello" },
    ],
    [
      "a link with a size",
      { name: under("l"), type: "symlink", linkname: "x", sizeInHeader: 5, content: "hello" },
    ],
  ] as const)("refuses %s", async (_label, entry) => {
    expect(await codeOf(tarball([entry]))).toBe("corrupt");
  });
});

describe("where an archive ends", () => {
  it("refuses an archive that stops before its end marker, in a header, in content and between entries", async () => {
    const full = tar([one, { name: under("b.txt"), content: "b".repeat(700) }], { endBlocks: 0 });
    for (const length of [
      0 + 100,
      512,
      512 + 1,
      1_024,
      1_024 + 512 + 100,
      full.length - 1,
      full.length,
    ]) {
      expect(await codeOf(gzip(full.subarray(0, length)))).toBe("corrupt");
    }
  });

  it("takes one block of zeros as the end, and any number of blocks, and nothing after it but zeros", async () => {
    for (const endBlocks of [1, 2, 20]) {
      const where = await place();
      await unpack(where, tarball([one], { endBlocks }));
      expect(await tree(where.dest)).toEqual(["f a.txt"]);
    }
    const where = await place();
    await unpack(where, gzip(Buffer.concat([tar([one]), Buffer.alloc(100_000)])));
  });

  it("refuses an archive that has a byte that is not zero after its end", async () => {
    const after = Buffer.alloc(2_000);
    after[1_500] = 1;
    expect(await codeOf(tarball([one], { after }))).toBe("corrupt");
    expect(await codeOf(tarball([one], { after: Buffer.from("x") }))).toBe("corrupt");
    // A second archive after the first is not read: it is bytes after the end.
    expect(
      await codeOf(gzip(Buffer.concat([tar([one]), tar([{ name: under("b"), content: "b" }])]))),
    ).toBe("corrupt");
  });

  it("refuses an end marker that is cut in the middle of a block", async () => {
    expect(
      await codeOf(gzip(Buffer.concat([tar([one], { endBlocks: 0 }), Buffer.alloc(256)]))),
    ).toBe("corrupt");
  });
});

describe("extended headers", () => {
  it("refuses two extended headers in a row, an extended header before the end, and one before a global one", async () => {
    const record = paxRecord("comment", "x");
    const x = (): Buffer =>
      Buffer.concat([
        header({ name: "x", flag: 0x78, size: record.length }),
        Buffer.concat([record, Buffer.alloc(512 - record.length)]),
      ]);
    expect(await codeOf(gzip(Buffer.concat([x(), x(), tar([one])])))).toBe("corrupt");
    expect(await codeOf(gzip(Buffer.concat([x(), Buffer.alloc(1_024)])))).toBe("corrupt");
    expect(await codeOf(gzip(Buffer.concat([x(), globalHeader(), tar([one])])))).toBe("corrupt");
  });

  it("refuses an extended header that has an entry that it applies to of a kind that is not accepted", async () => {
    expect(await codeOf(tarball([{ ...one, type: "hardlink", pax: { comment: "x" } }]))).toBe(
      "unsupported_entry",
    );
  });

  it("applies an extended header to the entry after it and not to the one after that", async () => {
    const where = await place();
    await unpack(
      where,
      tarball([
        { name: "decoy", pax: { path: under("renamed.txt") }, content: "first" },
        { name: under("second.txt"), content: "second" },
      ]),
    );
    expect(await tree(where.dest)).toEqual(["f renamed.txt", "f second.txt"]);
  });

  it("ignores the keys it does not read, and an extended header with no records", async () => {
    const where = await place();
    await unpack(
      where,
      tarball([
        {
          ...one,
          pax: {
            mtime: "1.5",
            comment: "hi",
            "SCHILY.xattr.user.x": "y",
            linkpath: "/etc/passwd",
            uid: "0",
          },
        },
        { name: under("b.txt"), rawPax: Buffer.alloc(0), content: "b" },
      ]),
    );
    expect(await tree(where.dest)).toEqual(["f a.txt", "f b.txt"]);
  });

  it("does not let a global extended header name a path or a size", async () => {
    const where = await place();
    const body = Buffer.concat([
      paxRecord("path", `${ROOT}/global-path`),
      paxRecord("size", "99999"),
    ]);
    const global = Buffer.concat([
      header({ name: "g", flag: 0x67, size: body.length }),
      Buffer.concat([body, Buffer.alloc(512 - body.length)]),
    ]);
    await unpack(where, gzip(Buffer.concat([global, tar([one])])));
    expect(await tree(where.dest)).toEqual(["f a.txt"]);
    expect(await contents(where.dest, "a.txt")).toBe("a");
  });

  it("takes a global extended header that is larger than a block", async () => {
    const where = await place();
    await unpack(where, gzip(Buffer.concat([globalHeader("c".repeat(3_000)), tar([one])])));
    expect(await tree(where.dest)).toEqual(["f a.txt"]);
  });
});

describe("a long run of entries", () => {
  it("unpacks a thousand files, in any order of directories", async () => {
    const entries: FixtureEntry[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      entries.push({
        name: under(`d${String(index % 17)}/e${String(index % 5)}/f${String(index)}.txt`),
        content: `file ${String(index)}`,
      });
    }
    const where = await place();
    const summary = await unpack(where, tarball(entries));
    expect(summary.files).toBe(1_000);
    expect(summary.directories).toBe(17 + 17 * 5);
    expect(await contents(where.dest, "d3/e3/f998.txt").catch(() => "none")).toBe("none");
    expect(await contents(where.dest, "d4/e3/f998.txt").catch(() => "none")).toBe("none");
    expect(await contents(where.dest, `d${String(998 % 17)}/e${String(998 % 5)}/f998.txt`)).toBe(
      "file 998",
    );
  });
});
