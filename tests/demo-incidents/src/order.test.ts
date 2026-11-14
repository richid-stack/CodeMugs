// Directories are read in whatever order the file system gives, which differs between file systems.
// The mocked read gives the names backwards, so that a result that depends on the order shows it.
import { createHash } from "node:crypto";
import type * as FsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadIncidents } from "./catalogue.js";
import { treeHash } from "./edits.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  return {
    ...real,
    readdir: async (...args: Parameters<typeof real.readdir>) =>
      [...(await (real.readdir as (...a: unknown[]) => Promise<unknown[]>)(...args))].reverse(),
  };
});

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "order-test-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("with a file system that lists names in the opposite order", () => {
  it("the mock does list backwards", async () => {
    await writeFile(join(directory, "a"), "");
    await writeFile(join(directory, "b"), "");
    expect(await readdir(directory)).toEqual(["b", "a"]);
  });

  it("treeHash is the hash of the names and contents in the order of the names", async () => {
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src", "b.ts"), "bee");
    await writeFile(join(directory, "src", "a.ts"), "ay");
    await writeFile(join(directory, "z"), "zed");
    const expected = createHash("sha256");
    for (const [name, content] of [
      ["src/a.ts", "ay"],
      ["src/b.ts", "bee"],
      ["z", "zed"],
    ] as const) {
      expected.update(`${name}\0${content}\0`);
    }
    expect(await treeHash(directory)).toBe(expected.digest("hex"));
  });

  it("loadIncidents gives the incidents in the order of their names", async () => {
    const incidents = await loadIncidents();
    const ids = incidents.map((incident) => incident.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(ids).toEqual([...ids].sort());
  });
});
