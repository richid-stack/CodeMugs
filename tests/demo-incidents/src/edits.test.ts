import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEdits, EditError, invertEdits, treeHash } from "./edits.js";
import type { Edit } from "./schema.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "edits-test-"));
  await mkdir(join(directory, "src"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function write(file: string, text: string): Promise<void> {
  await writeFile(join(directory, file), text);
}

async function read(file: string): Promise<string> {
  return readFile(join(directory, file), "utf8");
}

const edit = (find: string[], replace: string[], file = "src/a.ts"): Edit => ({
  file,
  find,
  replace,
});

describe("applyEdits", () => {
  it("changes a line that is in the file once", async () => {
    await write("src/a.ts", "one\ntwo\nthree\n");
    await applyEdits(directory, [edit(["two"], ["2"])]);
    expect(await read("src/a.ts")).toBe("one\n2\nthree\n");
  });

  it("changes lines that follow each other, and can change how many there are", async () => {
    await write("src/a.ts", "a\nb\nc\nd\n");
    await applyEdits(directory, [edit(["b", "c"], ["x", "y", "z"])]);
    expect(await read("src/a.ts")).toBe("a\nx\ny\nz\nd\n");
  });

  it("makes the edits one after the other, each on what the last left", async () => {
    await write("src/a.ts", "one\n");
    await applyEdits(directory, [edit(["one"], ["two"]), edit(["two"], ["three"])]);
    expect(await read("src/a.ts")).toBe("three\n");
  });

  it("changes more than one file", async () => {
    await write("src/a.ts", "a\n");
    await write("src/b.ts", "b\n");
    await applyEdits(directory, [edit(["a"], ["A"]), edit(["b"], ["B"], "src/b.ts")]);
    expect(await read("src/a.ts")).toBe("A\n");
    expect(await read("src/b.ts")).toBe("B\n");
  });

  it("takes the replacement as it is written, with no special meaning for a dollar", async () => {
    await write("src/a.ts", "price\n");
    await applyEdits(directory, [edit(["price"], ["`$&${price}$1$$`"])]);
    expect(await read("src/a.ts")).toBe("`$&${price}$1$$`\n");
  });

  it("says not_found when the text is not there, and names the file and the edit but not the text", async () => {
    await write("src/a.ts", "one\n");
    const failure = await applyEdits(directory, [
      edit(["one"], ["uno"]),
      edit(["a-secret-line"], ["x"]),
    ]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EditError);
    const error = failure as EditError;
    expect(error.code).toBe("not_found");
    expect(error.file).toBe("src/a.ts");
    expect(error.index).toBe(1);
    expect(error.message).toBe("edit 2 in src/a.ts: not_found");
    expect(error.message).not.toContain("a-secret-line");
  });

  it("says ambiguous when the text is there more than once", async () => {
    await write("src/a.ts", "x\nx\n");
    await expect(applyEdits(directory, [edit(["x"], ["y"])])).rejects.toMatchObject({
      name: "EditError",
      code: "ambiguous",
      index: 0,
    });
    expect(await read("src/a.ts")).toBe("x\nx\n");
  });

  it("does not count a second match that overlaps the first", async () => {
    // "aa" in "aaa" is found at 0, and the next search starts after it, so it is found once.
    await write("src/a.ts", "aaa");
    await applyEdits(directory, [edit(["aa"], ["b"])]);
    expect(await read("src/a.ts")).toBe("ba");
  });

  it("says unchanged when the edit would change nothing", async () => {
    await write("src/a.ts", "one\n");
    await expect(applyEdits(directory, [edit(["one"], ["one"])])).rejects.toMatchObject({
      code: "unchanged",
    });
  });

  it("fails when the file is not there", async () => {
    await expect(applyEdits(directory, [edit(["a"], ["b"], "src/none.ts")])).rejects.toThrow();
  });
});

describe("invertEdits", () => {
  it("swaps what is found and what replaces it, and reverses the order", () => {
    const edits = [edit(["a"], ["b"]), edit(["c"], ["d"], "src/b.ts")];
    expect(invertEdits(edits)).toEqual([edit(["d"], ["c"], "src/b.ts"), edit(["b"], ["a"])]);
  });

  it("does not change the edits it is given", () => {
    const edits = [edit(["a"], ["b"]), edit(["c"], ["d"])];
    invertEdits(edits);
    expect(edits).toEqual([edit(["a"], ["b"]), edit(["c"], ["d"])]);
  });

  it("undoes edits that depend on each other", async () => {
    await write("src/a.ts", "one\nfour\n");
    const before = await treeHash(directory);
    const edits = [edit(["one"], ["two"]), edit(["two", "four"], ["three", "five"])];
    await applyEdits(directory, edits);
    expect(await read("src/a.ts")).toBe("three\nfive\n");
    expect(await treeHash(directory)).not.toBe(before);
    await applyEdits(directory, invertEdits(edits));
    expect(await treeHash(directory)).toBe(before);
  });
});

describe("treeHash", () => {
  it("is the same for the same files, however they were made", async () => {
    await write("src/a.ts", "a");
    await write("src/b.ts", "b");
    const first = await treeHash(directory);
    const other = await mkdtemp(join(tmpdir(), "edits-test-"));
    try {
      await mkdir(join(other, "src"));
      await writeFile(join(other, "src/b.ts"), "b");
      await writeFile(join(other, "src/a.ts"), "a");
      expect(await treeHash(other)).toBe(first);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("changes when a file's content changes, when a file is renamed, and when one is added", async () => {
    await write("src/a.ts", "a");
    const start = await treeHash(directory);
    await write("src/a.ts", "A");
    const changed = await treeHash(directory);
    expect(changed).not.toBe(start);
    await write("src/b.ts", "b");
    expect(await treeHash(directory)).not.toBe(changed);
    const other = await mkdtemp(join(tmpdir(), "edits-test-"));
    try {
      await mkdir(join(other, "src"));
      await writeFile(join(other, "src/z.ts"), "a");
      expect(await treeHash(other)).not.toBe(start);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("does not mistake where a name ends and the content begins", async () => {
    const first = await mkdtemp(join(tmpdir(), "edits-test-"));
    const second = await mkdtemp(join(tmpdir(), "edits-test-"));
    try {
      await writeFile(join(first, "a"), "bc");
      await writeFile(join(second, "ab"), "c");
      expect(await treeHash(first)).not.toBe(await treeHash(second));
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });

  it("does not mistake where a content ends and the next name begins", async () => {
    const first = await mkdtemp(join(tmpdir(), "edits-test-"));
    const second = await mkdtemp(join(tmpdir(), "edits-test-"));
    try {
      await writeFile(join(first, "a"), "b");
      await writeFile(join(first, "cd"), "");
      await writeFile(join(second, "a"), "bc");
      await writeFile(join(second, "d"), "");
      expect(await treeHash(first)).not.toBe(await treeHash(second));
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });

  it("is the same whatever order the files were made in, when there are many", async () => {
    const names = Array.from(
      { length: 24 },
      (_, index) => `f${String((index * 7919) % 97).padStart(2, "0")}.ts`,
    );
    const first = await mkdtemp(join(tmpdir(), "edits-test-"));
    const second = await mkdtemp(join(tmpdir(), "edits-test-"));
    try {
      for (const name of names) await writeFile(join(first, name), name);
      for (const name of [...names].reverse()) await writeFile(join(second, name), name);
      expect(await treeHash(first)).toBe(await treeHash(second));
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });

  it("reads files in directories below, and tells an empty tree from one with an empty file", async () => {
    const empty = await treeHash(directory);
    await mkdir(join(directory, "src/deep"));
    await write("src/deep/c.ts", "");
    expect(await treeHash(directory)).not.toBe(empty);
  });
});
