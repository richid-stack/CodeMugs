import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ArchiveError } from "./errors.js";
import { createTarballExtractor, extractTarball } from "./extract.js";
import { gzip, tarball } from "./testing.js";
import { failureCode, place, tree, unpack } from "./test-support.js";

/**
 * The bytes that are given to an unpacking are bounded as well as the bytes that come out of it: a
 * caller that does not wait for one write before it makes the next, and a stream that goes on after
 * the archive has ended with something that expands to nothing, are both ways of making the
 * unpacking hold or read without end, and neither is stopped by a limit on what is written.
 */

const ROOT = "owner-repo-0123abc";
const CONTENT = randomBytes(4_000);
const ARCHIVE = tarball([{ name: `${ROOT}/data.bin`, content: CONTENT }]);

/** What one write that is waiting counts for, besides its bytes: its promise and its closures. */
const CALL = 1_024;
const PIECE = 100;

const pieces = (bytes: Buffer, size: number): Buffer[] => {
  const found: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += size) found.push(bytes.subarray(at, at + size));
  return found;
};

describe("the writes that are waiting", () => {
  it("refuses the write that would leave more waiting than the limit, and the unpacking stays failed", async () => {
    const where = await place();
    const extractor = await createTarballExtractor({
      destination: where.dest,
      limits: { maxPendingBytes: 2 * (PIECE + CALL) - 1 },
    });
    // Made one after the other without waiting, as a caller that does not wait would.
    const results = await Promise.allSettled(
      pieces(ARCHIVE, PIECE)
        .slice(0, 4)
        .map((piece) => extractor.write(piece)),
    );
    // All of them fail, the first too: the refusals fail the unpacking before the first one's turn,
    // because the bytes that were not taken leave a gap in the archive.
    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ArchiveError);
      expect((result as PromiseRejectedResult).reason).toMatchObject({ code: "invalid_input" });
    }
    // Nothing more is taken and nothing is finished.
    await expect(extractor.write(Buffer.alloc(1))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(extractor.finish()).rejects.toMatchObject({ code: "invalid_input" });
    expect(await tree(where.dest)).toEqual([]);
  });

  it("takes writes that leave exactly the limit waiting", async () => {
    const where = await place();
    const extractor = await createTarballExtractor({
      destination: where.dest,
      limits: { maxPendingBytes: 2 * (PIECE + CALL) },
    });
    const [first, second, ...rest] = pieces(ARCHIVE, PIECE);
    await Promise.all([
      extractor.write(first ?? Buffer.alloc(0)),
      extractor.write(second ?? Buffer.alloc(0)),
    ]);
    for (const piece of rest) await extractor.write(piece);
    await extractor.finish();
    expect(await tree(where.dest)).toEqual(["f data.bin"]);
  });

  it("never refuses a write that is the only one waiting, whatever its size", async () => {
    const where = await place();
    // Nothing may wait beside a write, and a write on its own is more than that and is taken.
    const limits = { maxPendingBytes: 0 };
    await unpack(where, ARCHIVE, limits);
    expect(await tree(where.dest)).toEqual(["f data.bin"]);

    const piecewise = await place();
    const extractor = await createTarballExtractor({ destination: piecewise.dest, limits });
    for (const piece of pieces(ARCHIVE, 7)) await extractor.write(piece);
    await extractor.finish();
    expect(await tree(piecewise.dest)).toEqual(["f data.bin"]);
  });

  it("counts a write by more than its bytes, so that many empty ones are refused too", async () => {
    const where = await place();
    const extractor = await createTarballExtractor({
      destination: where.dest,
      limits: { maxPendingBytes: 10 * CALL },
    });
    const results = await Promise.allSettled(
      Array.from({ length: 1_000 }, () => extractor.write(new Uint8Array(0))),
    );
    expect(results.filter((result) => result.status === "rejected").length).toBeGreaterThan(900);
    await expect(extractor.finish()).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("frees what a write counted for when it is done, so that a long stream that waits is never refused", async () => {
    const where = await place();
    const extractor = await createTarballExtractor({
      destination: where.dest,
      limits: { maxPendingBytes: 2 * (PIECE + CALL) },
    });
    const all = pieces(ARCHIVE, PIECE);
    // Two at a time, each pair waited for: far more than the limit has been given, never more
    // than it waiting.
    for (let at = 0; at < all.length; at += 2) {
      await Promise.all(all.slice(at, at + 2).map((piece) => extractor.write(piece)));
    }
    await extractor.finish();
    expect(await tree(where.dest)).toEqual(["f data.bin"]);
  });
});

describe("a refused write", () => {
  it("is refused at one more than the limit and not at the limit", async () => {
    const two = pieces(ARCHIVE, PIECE).slice(0, 2);
    const refused = await place();
    const over = await createTarballExtractor({
      destination: refused.dest,
      limits: { maxPendingBytes: 2 * (PIECE + CALL) - 1 },
    });
    const results = await Promise.allSettled(two.map((piece) => over.write(piece)));
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  });

  it("is refused at the same place after earlier writes were done", async () => {
    // What is waiting is counted back exactly when a write is done, so that a stream that has gone
    // on for a long time has not loosened the limit, or tightened it.
    const [done, ...next] = pieces(ARCHIVE, PIECE);
    const where = await place();
    const extractor = await createTarballExtractor({
      destination: where.dest,
      limits: { maxPendingBytes: 2 * (PIECE + CALL) - 1 },
    });
    await extractor.write(done ?? Buffer.alloc(0));
    const results = await Promise.allSettled(
      next.slice(0, 2).map((piece) => extractor.write(piece)),
    );
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  });

  it("says the failure that came first, which is the one that stays", async () => {
    const where = await place();
    const extractor = await createTarballExtractor({
      destination: where.dest,
      limits: { maxCompressedBytes: 10 },
    });
    await extractor.abort();
    // This write is over the limit, and the unpacking has already been stopped.
    await expect(extractor.write(Buffer.alloc(20))).rejects.toMatchObject({ code: "aborted" });
    await expect(extractor.finish()).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("the compressed bytes that are given", () => {
  it("are bounded exactly: the archive's own size is taken and one byte less is not", async () => {
    await unpack(await place(), ARCHIVE, { maxCompressedBytes: ARCHIVE.length });
    expect(
      await failureCode(unpack(await place(), ARCHIVE, { maxCompressedBytes: ARCHIVE.length - 1 })),
    ).toBe("too_large");
  });

  it("are counted as they are given, in pieces too", async () => {
    const where = await place();
    const extractor = await createTarballExtractor({
      destination: where.dest,
      limits: { maxCompressedBytes: ARCHIVE.length - 1 },
    });
    const all = pieces(ARCHIVE, 64);
    let taken = 0;
    let code: unknown;
    for (const piece of all) {
      try {
        await extractor.write(piece);
        taken += 1;
      } catch (error) {
        code = (error as ArchiveError).code;
        break;
      }
    }
    expect(code).toBe("too_large");
    expect(taken).toBe(all.length - 1);
    await expect(extractor.finish()).rejects.toMatchObject({ code: "too_large" });
  });

  it("stop a stream that goes on after the archive with members that expand to nothing", async () => {
    const empty = gzip(Buffer.alloc(0));
    let given = 0;
    async function* source(): AsyncGenerator<Buffer> {
      yield ARCHIVE;
      // Far more than the limit allows. Each one is a whole gzip member that holds nothing, so
      // what comes out of the unpacking never grows and the limit on that never stops it.
      for (let index = 0; index < 100_000; index += 1) {
        await Promise.resolve();
        given += 1;
        yield empty;
      }
    }
    const where = await place();
    const error: unknown = await extractTarball(source(), {
      destination: where.dest,
      limits: { maxCompressedBytes: ARCHIVE.length + 1_000 },
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ArchiveError);
    expect(error).toMatchObject({ code: "too_large" });
    // It stopped asking for more when the limit was reached.
    expect(given).toBeLessThan(Math.ceil(1_000 / empty.length) + 2);
  });

  it("do not stop an archive that is more compressed than it is long", async () => {
    // A tar of nothing but zeros compresses to a tiny stream and expands to a great deal, which is
    // what the limit on what it expands to is for. The compressed limit only counts what is given.
    const big = tarball([{ name: `${ROOT}/zeros`, content: Buffer.alloc(2_000_000) }]);
    expect(big.length).toBeLessThan(20_000);
    await unpack(await place(), big, { maxCompressedBytes: big.length });
  });
});
