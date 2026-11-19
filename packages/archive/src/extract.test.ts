import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ArchiveError } from "./errors.js";
import { createTarballExtractor, extractTarball } from "./extract.js";
import { gzip, globalHeader, inPieces, tar, tarball } from "./testing.js";
import {
  contents,
  everythingOf,
  expectNothingOutside,
  failure,
  failureCode,
  place,
  tree,
  unpack,
} from "./test-support.js";

const ROOT = "owner-repo-0123abc";
const under = (name: string) => `${ROOT}/${name}`;

describe("unpacking what git archive makes", () => {
  it("unpacks the files, directories and links of an archive, and none of its modes", async () => {
    const where = await place();
    const bytes = tarball([
      { name: `${ROOT}/`, type: "directory" },
      { name: under("src/"), type: "directory" },
      { name: under("src/index.ts"), content: "export const a = 1;\n", mode: 0o755 },
      { name: under("README.md"), content: "# hello\n", mode: 0o4755 },
      { name: under("empty.txt") },
      { name: under("link"), type: "symlink", linkname: "../../etc/passwd" },
    ]);
    const summary = await unpack(where, bytes);
    expect(await tree(where.dest)).toEqual([
      "f README.md",
      "f empty.txt",
      "l link -> .",
      "d src",
      "f src/index.ts",
    ]);
    expect(await contents(where.dest, "src/index.ts")).toBe("export const a = 1;\n");
    expect(await contents(where.dest, "README.md")).toBe("# hello\n");
    expect(summary).toMatchObject({
      entries: 5,
      files: 3,
      directories: 1,
      links: 1,
      contentBytes: "export const a = 1;\n".length + "# hello\n".length,
    });
    expect(summary.decompressedBytes).toBeGreaterThan(0);
    // The mode is ours: owner only, with no setuid, setgid or sticky bit and nothing for others.
    expect((await stat(join(where.dest, "README.md"))).mode & 0o7177).toBe(0);
    expect((await stat(join(where.dest, "src"))).mode & 0o7077).toBe(0);
  });

  it("reads the global header that git archive writes first, and does not use it", async () => {
    const where = await place();
    const bytes = gzip(
      Buffer.concat([globalHeader(), tar([{ name: under("a.txt"), content: "a" }])]),
    );
    await unpack(where, bytes);
    expect(await tree(where.dest)).toEqual(["f a.txt"]);
  });

  it("reads a path that is in an extended header, and prefers it to the name in the header", async () => {
    const where = await place();
    const long = `${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(60)}.txt`;
    await unpack(
      where,
      tarball([{ name: "decoy.txt", pax: { path: under(long) }, content: "long" }]),
    );
    expect(await contents(where.dest, long)).toBe("long");
    expect(await tree(where.dest)).not.toContain("f decoy.txt");
  });

  it("reads a path that is split between the prefix and the name of a header", async () => {
    const where = await place();
    const name = `${ROOT}/${"p".repeat(90)}/${"q".repeat(60)}.txt`;
    await unpack(where, tarball([{ name, content: "split" }]));
    expect(await contents(where.dest, `${"p".repeat(90)}/${"q".repeat(60)}.txt`)).toBe("split");
  });

  it("reads a size that is in an extended header and not in the header", async () => {
    const where = await place();
    await unpack(
      where,
      tarball([
        { name: under("a.txt"), pax: { size: "5" }, content: "hello", sizeInHeader: 0 },
        { name: under("b.txt"), content: "after" },
      ]),
    );
    expect(await contents(where.dest, "a.txt")).toBe("hello");
    expect(await contents(where.dest, "b.txt")).toBe("after");
  });

  it("makes the directories that a path needs, and takes a directory that comes after its files", async () => {
    const where = await place();
    await unpack(
      where,
      tarball([
        { name: under("a/b/c.txt"), content: "c" },
        { name: under("a/"), type: "directory" },
        { name: under("a/b/"), type: "directory" },
      ]),
    );
    expect(await tree(where.dest)).toEqual(["d a", "d a/b", "f a/b/c.txt"]);
  });

  it("makes nothing from an archive that holds only its top directory, or nothing at all", async () => {
    const first = await place();
    expect(await unpack(first, tarball([{ name: `${ROOT}/`, type: "directory" }]))).toMatchObject({
      entries: 0,
    });
    const second = await place();
    expect(await unpack(second, tarball([]))).toMatchObject({ entries: 0, contentBytes: 0 });
    expect(await readdir(first.dest)).toEqual([]);
    expect(await readdir(second.dest)).toEqual([]);
  });

  it.each([
    ["a newline", "line\nbreak.txt"],
    ["a space", "with space.txt"],
    ["unicode", "naïve-日本語-🙂.txt"],
    ["a leading dash", "-rf"],
    ["a name of dots and a letter", "..a"],
    ["three dots", "..."],
    ["a backslash", "a\\b.txt"],
    ["a name that is .git", ".git"],
    ["a name of 255 bytes", "n".repeat(255)],
  ])("accepts a legal name with %s", async (_label, name) => {
    const where = await place();
    // A name over 100 bytes does not fit a header's name field, so it goes in an extended header.
    await unpack(where, tarball([{ name: "decoy", pax: { path: under(name) }, content: "x" }]));
    expect(await tree(where.dest)).toEqual([`f ${name}`]);
  });

  it.each([0, 1, 511, 512, 513, 1_024, 65_535, 65_536, 65_537, 1_048_576])(
    "keeps the bytes of a file of %i bytes",
    async (size) => {
      const where = await place();
      const content = Buffer.alloc(size);
      for (let index = 0; index < size; index += 1) content[index] = (index * 31 + 7) % 251;
      await unpack(
        where,
        tarball([
          { name: under("f.bin"), content },
          { name: under("g.txt"), content: "after" },
        ]),
      );
      const { readFile } = await import("node:fs/promises");
      expect(Buffer.compare(await readFile(join(where.dest, "f.bin")), content)).toBe(0);
      expect(await contents(where.dest, "g.txt")).toBe("after");
    },
  );

  it.each([1, 2, 7, 100, 511, 512, 513, 4_096, 100_000])(
    "gives the same result when the bytes arrive in pieces of %i",
    async (piece) => {
      const entries = [
        { name: `${ROOT}/`, type: "directory" as const },
        { name: under("a/b/c.txt"), content: "c".repeat(700) },
        { name: under("empty"), content: "" },
        { name: under("long"), pax: { path: under(`${"x".repeat(150)}.txt`) }, content: "L" },
        { name: under("link"), type: "symlink" as const, linkname: "t" },
        { name: under("z.txt"), content: "z" },
      ];
      const reference = await place();
      await unpack(reference, tarball(entries));
      const where = await place();
      await unpack(where, inPieces(tarball(entries), [piece]));
      expect(await tree(where.dest)).toEqual(await tree(reference.dest));
      expect(await contents(where.dest, "a/b/c.txt")).toBe("c".repeat(700));
    },
  );

  it("unpacks the archive that git archive makes", async () => {
    const work = await mkdtemp(join(tmpdir(), "archive-git-"));
    try {
      const run = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: work,
          env: {
            PATH: process.env["PATH"] ?? "",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@example.invalid",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@example.invalid",
          },
          encoding: "buffer",
        });
      run("init", "-q", "-b", "main");
      const longDirectory = Array.from(
        { length: 6 },
        (_, index) => `directory-number-${String(index)}-x`,
      ).join("/");
      await mkdir(join(work, "src"), { recursive: true });
      await mkdir(join(work, longDirectory), { recursive: true });
      await writeFile(join(work, "src", "index.ts"), "export {};\n");
      await writeFile(join(work, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
      await writeFile(join(work, "empty"), "");
      await writeFile(join(work, "naïve 日本.txt"), "unicode");
      const longName = `${"l".repeat(130)}.txt`;
      await writeFile(join(work, longName), "long name");
      await writeFile(join(work, longDirectory, "deep-file-with-a-long-name.txt"), "deep");
      await symlink("src/index.ts", join(work, "link"));
      run("add", "-A");
      run("commit", "-q", "-m", "one");
      const sha = run("rev-parse", "HEAD").toString().trim();
      const archive = run("archive", "--format=tar", `--prefix=owner-repo-${sha}/`, "HEAD");
      expect(archive.includes(Buffer.from("pax_global_header"))).toBe(true);
      // A name of more than 100 bytes in one part is what makes git write an extended header.
      expect(archive.includes(Buffer.from(`/${longName}\n`))).toBe(true);
      expect(archive.includes(Buffer.from(" path=owner-repo-"))).toBe(true);
      const where = await place();
      const summary = await unpack(where, gzip(archive));
      expect((await tree(where.dest)).sort()).toEqual(
        [
          "f empty",
          `f ${longName}`,
          "l link -> .",
          "f naïve 日本.txt",
          "f run.sh",
          "d src",
          "f src/index.ts",
          ...longDirectory
            .split("/")
            .map((_, index, all) => `d ${all.slice(0, index + 1).join("/")}`),
          `f ${longDirectory}/deep-file-with-a-long-name.txt`,
        ].sort(),
      );
      expect(await contents(where.dest, `${longDirectory}/deep-file-with-a-long-name.txt`)).toBe(
        "deep",
      );
      expect(await contents(where.dest, longName)).toBe("long name");
      expect(summary.links).toBe(1);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("the extractor's use", () => {
  it("unpacks from a source of bytes, and stops if the source fails", async () => {
    const where = await place();
    const bytes = tarball([{ name: under("a.txt"), content: "a" }]);
    const summary = await extractTarball(Readable.from(inPieces(bytes, [10])), {
      destination: where.dest,
    });
    expect(summary.files).toBe(1);

    const failing = await place();
    const source = (async function* () {
      await Promise.resolve();
      yield bytes.subarray(0, 20);
      throw new Error("the connection was reset");
    })();
    await expect(extractTarball(source, { destination: failing.dest })).rejects.toThrow(
      "the connection was reset",
    );
  });

  it("takes writes in the order they were made, even when they are made together", async () => {
    const where = await place();
    const bytes = tarball([{ name: under("a/b.txt"), content: "ordered".repeat(500) }]);
    const extractor = await createTarballExtractor({ destination: where.dest });
    await Promise.all(inPieces(bytes, [13]).map((piece) => extractor.write(piece)));
    expect((await extractor.finish()).files).toBe(1);
    expect(await contents(where.dest, "a/b.txt")).toBe("ordered".repeat(500));
  });

  it("reports what it has seen so far", async () => {
    const where = await place();
    const extractor = await createTarballExtractor({ destination: where.dest });
    expect(extractor.progress()).toMatchObject({ entries: 0, decompressedBytes: 0 });
    await extractor.write(tarball([{ name: under("a.txt"), content: "a" }]));
    await extractor.finish();
    expect(extractor.progress()).toMatchObject({ entries: 1, files: 1 });
  });

  it("refuses a write after the end, a second end, and a write of something that is not bytes", async () => {
    const where = await place();
    const extractor = await createTarballExtractor({ destination: where.dest });
    await extractor.write(tarball([]));
    await expect(extractor.write("text" as unknown as Uint8Array)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await extractor.finish();
    expect(await failureCode(extractor.write(Buffer.from("x")))).toBe("invalid_input");
    expect(await failureCode(extractor.finish())).toBe("invalid_input");
    await extractor.abort();
  });

  it("stays failed once it has failed, and abort is safe to repeat", async () => {
    const where = await place();
    const extractor = await createTarballExtractor({ destination: where.dest });
    expect(
      await failureCode(extractor.write(Buffer.from("this is not gzip at all, not even close"))),
    ).toBe("corrupt");
    expect(await failureCode(extractor.write(tarball([])))).toBe("corrupt");
    expect(await failureCode(extractor.finish())).toBe("corrupt");
    await extractor.abort();
    await extractor.abort();
    // The first failure is the one that is kept, and abort does not replace it.
    expect(await failureCode(extractor.finish())).toBe("corrupt");
  });

  it("is not failed by an abort that comes after it has finished", async () => {
    const where = await place();
    const extractor = await createTarballExtractor({ destination: where.dest });
    await extractor.write(tarball([{ name: under("a.txt"), content: "a" }]));
    await extractor.finish();
    await extractor.abort();
    expect(await failureCode(extractor.write(Buffer.from("x")))).toBe("invalid_input");
  });

  it("is stopped by abort, and says so to what is waiting", async () => {
    const where = await place();
    const extractor = await createTarballExtractor({ destination: where.dest });
    await extractor.write(tarball([{ name: under("a.txt"), content: "a" }]).subarray(0, 30));
    await extractor.abort();
    expect(await failureCode(extractor.write(Buffer.from("x")))).toBe("aborted");
    expect(await failureCode(extractor.finish())).toBe("aborted");
  });

  it("ignores an empty piece", async () => {
    const where = await place();
    const extractor = await createTarballExtractor({ destination: where.dest });
    await extractor.write(Buffer.alloc(0));
    await extractor.write(tarball([{ name: under("a.txt"), content: "a" }]));
    expect((await extractor.finish()).files).toBe(1);
  });
});

describe("the destination", () => {
  it.each([
    ["a relative path", () => "relative/path"],
    ["a path that does not exist", () => join(tmpdir(), "archive-test-missing-path-xyz")],
    ["an empty string", () => ""],
  ])("refuses %s", async (_label, destination) => {
    expect(await failureCode(createTarballExtractor({ destination: destination() }))).toBe(
      "invalid_input",
    );
  });

  it("refuses a file, a directory that is not empty and a link to a directory", async () => {
    const where = await place();
    const file = join(where.base, "a-file");
    await writeFile(file, "x");
    expect(await failureCode(createTarballExtractor({ destination: file }))).toBe("invalid_input");
    expect(await failureCode(createTarballExtractor({ destination: where.base }))).toBe(
      "invalid_input",
    );
    const link = join(where.base, "link-to-dest");
    await symlink(where.dest, link);
    expect(await failureCode(createTarballExtractor({ destination: link }))).toBe("invalid_input");
  });

  it("refuses a relative path to a directory that exists and is empty", async () => {
    const where = await place();
    const relative = (await import("node:path")).relative(process.cwd(), where.dest);
    expect(isAbsolute(relative)).toBe(false);
    expect(await failureCode(createTarballExtractor({ destination: relative }))).toBe(
      "invalid_input",
    );
  });

  it("refuses a destination that is not a string", async () => {
    expect(await failureCode(createTarballExtractor({ destination: 5 as unknown as string }))).toBe(
      "invalid_input",
    );
  });

  it("refuses a limit that is not known, or is not a whole number that is not negative", async () => {
    const where = await place();
    for (const limits of [
      { nothing: 1 },
      { maxEntries: -1 },
      { maxEntries: 1.5 },
      { maxEntries: "5" },
    ]) {
      await expect(
        createTarballExtractor({ destination: where.dest, limits: limits as never }),
      ).rejects.toThrow(RangeError);
    }
    expect(new ArchiveError("corrupt")).toBeInstanceOf(Error);
  });
});

describe("when the disk is not as the extractor expects", () => {
  it("says write_failed, and nothing of the system's error, when a path cannot be made", async () => {
    const where = await place();
    const extractor = await createTarballExtractor({ destination: where.dest });
    // The destination goes away after it was checked.
    await rm(where.dest, { recursive: true });
    const error = await failure(
      extractor
        .write(tarball([{ name: under("a.txt"), content: "a" }]))
        .then(() => extractor.finish()),
    );
    expect(error.code).toBe("write_failed");
    expect(everythingOf(error)).not.toContain(where.base);
    expect(everythingOf(error)).not.toContain("ENOENT");
    await extractor.abort();
  });

  it("does not write over a file that is already there, or through a link that is already there", async () => {
    const where = await place();
    const extractor = await createTarballExtractor({ destination: where.dest });
    await writeFile(join(where.dest, "a.txt"), "was here");
    await symlink(join(where.outside, "sentinel.txt"), join(where.dest, "b.txt"));
    const first = await failure(
      extractor
        .write(tarball([{ name: under("a.txt"), content: "overwritten" }]))
        .then(() => extractor.finish()),
    );
    expect(first.code).toBe("write_failed");
    expect(await readFile(join(where.dest, "a.txt"), "utf8")).toBe("was here");

    const other = await createTarballExtractor({ destination: where.dest }).catch(() => undefined);
    // (The destination is no longer empty, so a second extractor is refused.)
    expect(other).toBeUndefined();
    expect(await expectNothingOutside(where)).toEqual([]);
  });

  it("does not write through a link that was put where a file is to be made", async () => {
    const where = await place();
    const extractor = await createTarballExtractor({ destination: where.dest });
    await symlink(join(where.outside, "sentinel.txt"), join(where.dest, "b.txt"));
    const error = await failure(
      extractor
        .write(tarball([{ name: under("b.txt"), content: "overwritten" }]))
        .then(() => extractor.finish()),
    );
    expect(error.code).toBe("write_failed");
    expect(await expectNothingOutside(where)).toEqual([]);
  });

  it("takes a finish that is asked for while a write is still being made, and waits for it", async () => {
    const where = await place();
    const extractor = await createTarballExtractor({ destination: where.dest });
    const bytes = tarball([{ name: under("a.txt"), content: "a".repeat(5_000) }]);
    const written = extractor.write(bytes);
    const finished = extractor.finish();
    await written;
    expect((await finished).files).toBe(1);
  });
});
