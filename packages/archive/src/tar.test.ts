import { describe, expect, it } from "vitest";
import { ArchiveError } from "./errors.js";
import { TarReader, type TarEntry, type TarSink } from "./tar.js";
import { gzip, header, paxRecord, tar } from "./testing.js";
import { extractTarball } from "./extract.js";
import { Readable } from "node:stream";
import { place, tree } from "./test-support.js";

/** A sink that writes down what it was given, in the order that it was given it. */
function recorder(): { sink: TarSink; events: string[] } {
  const events: string[] = [];
  const sink: TarSink = {
    entry(entry: TarEntry): Promise<void> {
      events.push(`entry ${entry.kind} ${entry.path.toString()} ${String(entry.size)}`);
      return Promise.resolve();
    },
    data(chunk: Buffer): Promise<void> {
      events.push(`data ${chunk.toString()}`);
      return Promise.resolve();
    },
    endEntry(): Promise<void> {
      events.push("end");
      return Promise.resolve();
    },
  };
  return { sink, events };
}

const reader = (sink: TarSink, maxExtendedHeaderBytes = 65_536) =>
  new TarReader(sink, { maxExtendedHeaderBytes });

describe("TarReader", () => {
  it("gives each entry, its content in the pieces that came, and the end of it, in order", async () => {
    const { sink, events } = recorder();
    const tarReader = reader(sink);
    const bytes = tar([
      { name: "r/a.txt", content: "hello world" },
      { name: "r/d/", type: "directory" },
      { name: "r/l", type: "symlink", linkname: "x" },
      { name: "r/empty" },
    ]);
    // 517 bytes cut the content of the first file in two, after its first five bytes.
    await tarReader.write(bytes.subarray(0, 517));
    await tarReader.write(bytes.subarray(517));
    tarReader.finish();
    expect(events).toEqual([
      "entry file r/a.txt 11",
      "data hello",
      "data  world",
      "end",
      "entry directory r/d/ 0",
      "end",
      "entry symlink r/l 0",
      "end",
      "entry file r/empty 0",
      "end",
    ]);
  });

  it("finishes only at an end marker", async () => {
    const empty = reader(recorder().sink);
    expect(() => {
      empty.finish();
    }).toThrow(ArchiveError);
    const ended = reader(recorder().sink);
    await ended.write(Buffer.alloc(512));
    expect(() => {
      ended.finish();
    }).not.toThrow();
    const partial = reader(recorder().sink);
    await partial.write(Buffer.alloc(511));
    expect(() => {
      partial.finish();
    }).toThrow(ArchiveError);
  });

  it.each([
    ["in the first piece of a long run of zeros", 10],
    ["at the end of the first piece", 65_535],
    ["at the start of the second piece", 65_536],
    ["in the middle of a later piece", 150_000],
    ["in the last byte", 199_999],
  ])("refuses a byte that is not zero after the end, %s", async (_label, position) => {
    const run = Buffer.alloc(200_000);
    run[position] = 1;
    const tarReader = reader(recorder().sink);
    await tarReader.write(Buffer.alloc(512));
    await expect(tarReader.write(run)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("takes a long run of zeros after the end, in one piece and in two", async () => {
    const tarReader = reader(recorder().sink);
    await tarReader.write(Buffer.alloc(512));
    await tarReader.write(Buffer.alloc(300_000));
    await tarReader.write(Buffer.alloc(70_000));
    tarReader.finish();
  });

  it("holds an extended header to the limit it is given", async () => {
    const body = Buffer.from("12 path=abc\n");
    const bytes = tar([{ name: "r/a", rawPax: body, content: "x" }]);
    const exact = reader(recorder().sink, body.length);
    await exact.write(bytes);
    exact.finish();
    const under = reader(recorder().sink, body.length - 1);
    await expect(under.write(bytes)).rejects.toMatchObject({ code: "too_large" });
  });

  it("does not keep the pieces it was given: a piece that is written over does not change an extended header", async () => {
    const { sink, events } = recorder();
    const tarReader = reader(sink);
    const bytes = tar([{ name: "decoy", pax: { path: "r/real-name.txt" }, content: "x" }]);
    const reused = Buffer.alloc(100);
    for (let offset = 0; offset < bytes.length; offset += reused.length) {
      const piece = bytes.subarray(offset, offset + reused.length);
      piece.copy(reused);
      await tarReader.write(reused.subarray(0, piece.length));
      reused.fill(0x7a);
    }
    tarReader.finish();
    expect(events[0]).toBe("entry file r/real-name.txt 1");
  });
});

/** An extended-header record with the length that it has: `<length> <content>\n`. */
function withLength(content: string): Buffer {
  let length = content.length + 2;
  while (String(length).length + 1 + content.length + 1 !== length) length += 1;
  return Buffer.from(`${String(length)} ${content}\n`);
}

async function readBody(body: Buffer, maxExtendedHeaderBytes = 65_536): Promise<string[]> {
  const { sink, events } = recorder();
  const tarReader = reader(sink, maxExtendedHeaderBytes);
  await tarReader.write(tar([{ name: "r/a", rawPax: body, content: "x" }]));
  tarReader.finish();
  return events;
}

describe("extended headers, read directly", () => {
  it("builds the records the way tar does, which is what the cases below are measured with", () => {
    expect(withLength("path=abc").toString()).toBe("12 path=abc\n");
    expect(withLength("path=" + "a".repeat(100)).toString()).toBe(`110 path=${"a".repeat(100)}\n`);
  });

  it("takes well formed records, in any number, and uses the last of a key", async () => {
    expect((await readBody(withLength("path=r/one")))[0]).toBe("entry file r/one 1");
    const two = Buffer.concat([
      withLength("path=r/one"),
      withLength("mtime=1.5"),
      withLength("path=r/two"),
    ]);
    expect((await readBody(two))[0]).toBe("entry file r/two 1");
    expect((await readBody(Buffer.concat([withLength("size=1"), withLength("path=r/s")])))[0]).toBe(
      "entry file r/s 1",
    );
  });

  it.each([
    ["a length that is too short", Buffer.from("5 path=x\n")],
    ["a length that is too long", Buffer.from("99 path=x\n")],
    ["a length that runs one past the end", Buffer.from("11 path=x\n")],
    ["a length that is not a number", Buffer.from("ab path=x\n")],
    ["no length", Buffer.from(" path=x\n")],
    ["a length of nothing", Buffer.from("0 path=x\n")],
    ["a length of one", Buffer.from("1 \n")],
    ["a length with no space after it", Buffer.from("12xpath=abc\n")],
    ["a length with nothing after it", Buffer.from("12")],
    ["no newline", Buffer.from("10 path=xx")],
    ["no equals sign", withLength("pathxx")],
    ["an empty key", withLength("=path")],
    ["an empty path", withLength("path=")],
    ["a path with a NUL", withLength("path=a\0b")],
    ["a value with a NUL, of a key that is not read", withLength("comment=a\0b")],
    ["a size that is not a number", withLength("size=12a")],
    ["a size with a sign", withLength("size=-1")],
    ["a size that is empty", withLength("size=")],
    ["a record that runs past the end", Buffer.from("20 path=abc\n")],
    ["text after the last record", Buffer.concat([withLength("path=abc"), Buffer.from("xx")])],
    [
      "a second record that is not well formed",
      Buffer.concat([withLength("path=abc"), Buffer.from("5 a=b\n")]),
    ],
  ])("refuses %s, as an ArchiveError and nothing else", async (_label, body) => {
    await expect(readBody(body)).rejects.toMatchObject({ name: "ArchiveError", code: "corrupt" });
  });

  it("refuses a size that is not safe in a double before it gives the entry", async () => {
    const { sink, events } = recorder();
    const tarReader = reader(sink);
    const bytes = tar([{ name: "r/a", rawPax: withLength("size=9007199254740993"), content: "x" }]);
    await expect(tarReader.write(bytes)).rejects.toMatchObject({ code: "too_large" });
    expect(events).toEqual([]);
  });

  it("applies the records of one extended header to its entry and not to the next one", async () => {
    const { sink, events } = recorder();
    const tarReader = reader(sink);
    await tarReader.write(
      tar([
        { name: "decoy", pax: { path: "r/first.txt" }, content: "1" },
        { name: "r/second.txt", pax: { comment: "x" }, content: "2" },
      ]),
    );
    expect(events.filter((event) => event.startsWith("entry"))).toEqual([
      "entry file r/first.txt 1",
      "entry file r/second.txt 1",
    ]);
  });

  it("copies the pieces of an extended header, because the caller reuses them", async () => {
    const { sink, events } = recorder();
    const tarReader = reader(sink);
    const bytes = tar([{ name: "decoy", pax: { path: "r/real-name.txt" }, content: "x" }]);
    // The header block is 512 bytes, so the body starts in the first piece and ends in the next.
    const reused = Buffer.alloc(520);
    for (let offset = 0; offset < bytes.length; offset += reused.length) {
      const piece = bytes.subarray(offset, offset + reused.length);
      piece.copy(reused);
      await tarReader.write(reused.subarray(0, piece.length));
      reused.fill(0x7a);
    }
    tarReader.finish();
    expect(events[0]).toBe("entry file r/real-name.txt 1");
  });
});

describe("entries, read directly", () => {
  it("takes a file whose type is the old NUL", async () => {
    const { sink, events } = recorder();
    const tarReader = reader(sink);
    await tarReader.write(tar([{ name: "r/old", type: "old-file", content: "o" }]));
    expect(events[0]).toBe("entry file r/old 1");
  });

  it.each([
    ["a directory", { name: "r/d/", type: "directory" as const }],
    ["a link", { name: "r/l", type: "symlink" as const, linkname: "x" }],
  ])("refuses %s with a size, before it gives the entry", async (_label, entry) => {
    const { sink, events } = recorder();
    const tarReader = reader(sink);
    const bytes = tar([{ ...entry, sizeInHeader: 5, content: "hello" }]);
    await expect(tarReader.write(bytes)).rejects.toMatchObject({ code: "corrupt" });
    expect(events).toEqual([]);
  });

  it.each([
    ["a name", 10],
    ["a mode", 105],
    ["the middle of the header", 300],
    ["the last byte", 511],
  ])(
    "does not take a block as the end marker when it has a byte that is not zero in %s",
    async (_label, position) => {
      const block = Buffer.alloc(512);
      block[position] = 0x31;
      const tarReader = reader(recorder().sink);
      await expect(
        tarReader.write(Buffer.concat([block, Buffer.alloc(1_024)])),
      ).rejects.toMatchObject({
        code: "corrupt",
      });
    },
  );

  it("refuses a header with a name and nothing else that makes it one", async () => {
    const block = header({ name: "r/a", flag: 0x30, size: 0 });
    block.fill(0, 257, 265);
    const tarReader = reader(recorder().sink);
    await expect(tarReader.write(block)).rejects.toMatchObject({ code: "corrupt" });
  });
});

describe("the second of two extended headers, through the extractor", () => {
  it("is its own, and does not carry the records of the first", async () => {
    const where = await place();
    await extractTarball(
      Readable.from([
        gzip(
          tar([
            { name: "decoy", pax: { path: "r/first.txt" }, content: "1" },
            { name: "r/second.txt", pax: { comment: "x" }, content: "2" },
          ]),
        ),
      ]),
      { destination: where.dest },
    );
    expect(await tree(where.dest)).toEqual(["f first.txt", "f second.txt"]);
    void paxRecord;
  });
});
