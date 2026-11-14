import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadIncidents } from "./catalogue.js";
import { EditError, treeHash } from "./edits.js";
import { materialiseIncident, materialiseShop, SHOP_DIRECTORY } from "./materialise.js";

let target: string;

beforeEach(async () => {
  target = join(await mkdtemp(join(tmpdir(), "materialise-test-")), "copy");
});

afterEach(async () => {
  await rm(join(target, ".."), { recursive: true, force: true });
});

async function filesOf(directory: string): Promise<string[]> {
  return (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1))
    .sort();
}

/**
 * Words that would tell the engine where a copy came from, or that something is wrong with it. The
 * shop's own word for its products, "catalogue", is a word of the shop and not on this list.
 */
const GIVEAWAYS: readonly [string, RegExp][] = [
  ["fault", /\bfaults?\b/i],
  ["incident", /\bincidents?\b/i],
  ["seeded", /\bseeded\b/i],
  ["planted", /\bplanted\b/i],
  ["ground truth", /ground[ -]truth/i],
  ["ADR", /\bADRs?\b/],
  ["CodeMugs", /code[ -]?mugs/i],
  ["sandbox", /sandbox/i],
  ["witness", /\bwitness\b/i],
  ["detector", /\bdetectors?\b/i],
  ["root cause", /root[ -]cause/i],
];

describe("materialiseShop", () => {
  it("makes a copy of the shop that holds its source, its configuration and a readme", async () => {
    await materialiseShop(target);
    const files = await filesOf(target);
    expect(files).toEqual(
      expect.arrayContaining([
        "README.md",
        "package.json",
        "tsconfig.json",
        "src/main.ts",
        "src/orders.ts",
        "src/inventory.ts",
        "src/orders.test.ts",
      ]),
    );
    expect(files.every((file) => !file.startsWith("node_modules"))).toBe(true);
  });

  it("copies every file of the shop's source, unchanged", async () => {
    await materialiseShop(target);
    const source = (await filesOf(join(SHOP_DIRECTORY, "src"))).sort();
    const copied = (await filesOf(join(target, "src"))).sort();
    expect(copied).toEqual(source);
    for (const file of source) {
      expect(await readFile(join(target, "src", file), "utf8")).toBe(
        await readFile(join(SHOP_DIRECTORY, "src", file), "utf8"),
      );
    }
  });

  it("holds nothing that says where it came from or that anything is wrong with it", async () => {
    await materialiseShop(target);
    for (const file of await filesOf(target)) {
      const text = await readFile(join(target, file), "utf8");
      for (const [word, pattern] of GIVEAWAYS) {
        expect(pattern.test(text), `${file} says "${word}"`).toBe(false);
      }
    }
  });

  it("writes a package.json of its own, that says how to run the shop and nothing about its place here", async () => {
    await materialiseShop(target);
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(manifest).sort()).toEqual(
      ["engines", "name", "private", "scripts", "type", "version"].sort(),
    );
    expect(manifest["name"]).toBe("demo-shop");
    expect(manifest["private"]).toBe(true);
    expect(manifest["type"]).toBe("module");
    const shop = JSON.parse(await readFile(join(SHOP_DIRECTORY, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest["scripts"]).toEqual(shop["scripts"]);
    expect(manifest["engines"]).toEqual(shop["engines"]);
    expect(manifest["version"]).toBe(shop["version"]);
  });

  it("writes a tsconfig that stands alone, with the options the shop takes from the repository", async () => {
    await materialiseShop(target);
    const config = JSON.parse(await readFile(join(target, "tsconfig.json"), "utf8")) as {
      extends?: string;
      compilerOptions: Record<string, unknown>;
      include: string[];
    };
    expect(config.extends).toBeUndefined();
    expect(config.include).toEqual(["src"]);
    expect(config.compilerOptions["strict"]).toBe(true);
    expect(config.compilerOptions["noEmit"]).toBe(true);
    expect(config.compilerOptions["erasableSyntaxOnly"]).toBe(true);
    expect(config.compilerOptions["allowImportingTsExtensions"]).toBe(true);
  });

  it("describes the shop in its readme as an ordinary application", async () => {
    await materialiseShop(target);
    const readme = await readFile(join(target, "README.md"), "utf8");
    expect(readme).toContain("# demo-shop");
    expect(readme).toContain("POST /orders");
    expect(readme).toContain("node --test");
  });

  it("copies from the source it is given, and takes the base options from two directories up", async () => {
    const root = await mkdtemp(join(tmpdir(), "materialise-layout-"));
    try {
      const source = join(root, "tests", "shop");
      await mkdir(join(source, "src"), { recursive: true });
      await writeFile(join(source, "src", "only.ts"), "export const only = 1;\n");
      await writeFile(
        join(source, "package.json"),
        JSON.stringify({ version: "9.9.9", engines: { node: ">=1" }, scripts: { test: "t" } }),
      );
      await writeFile(
        join(source, "tsconfig.json"),
        JSON.stringify({
          extends: "../../tsconfig.base.json",
          compilerOptions: { noEmit: true, strict: false },
          include: ["src"],
        }),
      );
      await writeFile(
        join(root, "tsconfig.base.json"),
        JSON.stringify({ compilerOptions: { target: "ES2024", strict: true } }),
      );
      await materialiseShop(target, source);
      expect(await filesOf(target)).toEqual([
        "README.md",
        "package.json",
        "src/only.ts",
        "tsconfig.json",
      ]);
      const config = JSON.parse(await readFile(join(target, "tsconfig.json"), "utf8")) as {
        compilerOptions: Record<string, unknown>;
      };
      // The shop's own options win over the base's, and the base's fill in the rest.
      expect(config.compilerOptions).toEqual({ target: "ES2024", strict: false, noEmit: true });
      const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as Record<
        string,
        unknown
      >;
      expect(manifest["version"]).toBe("9.9.9");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the source has no repository base to take options from", async () => {
    await materialiseShop(target);
    await expect(materialiseShop(join(target, "..", "again"), target)).rejects.toThrow();
  });

  it("makes the same copy every time", async () => {
    await materialiseShop(target);
    const again = join(target, "..", "again");
    await materialiseShop(again);
    expect(await treeHash(again)).toBe(await treeHash(target));
  });
});

describe("materialiseIncident", () => {
  it("makes a copy that differs from the shop in what the edits say, and nowhere else", async () => {
    const incidents = await loadIncidents();
    const clean = join(target, "..", "clean");
    await materialiseShop(clean);
    for (const incident of incidents) {
      const copy = join(target, "..", incident.id);
      await materialiseIncident(copy, incident);
      expect(await treeHash(copy)).not.toBe(await treeHash(clean));
      const changed = new Set(incident.edits.map((edit) => edit.file));
      for (const file of await filesOf(clean)) {
        const same =
          (await readFile(join(copy, file), "utf8")) ===
          (await readFile(join(clean, file), "utf8"));
        expect(same, `${incident.id}: ${file}`).toBe(!changed.has(file));
      }
    }
  });

  it("holds nothing that says where it came from or that anything is wrong with it", async () => {
    for (const incident of await loadIncidents()) {
      const copy = join(target, "..", incident.id);
      await materialiseIncident(copy, incident);
      for (const file of await filesOf(copy)) {
        const text = await readFile(join(copy, file), "utf8");
        for (const [word, pattern] of GIVEAWAYS) {
          expect(pattern.test(text), `${incident.id}: ${file} says "${word}"`).toBe(false);
        }
      }
    }
  });

  it("fails with an edit error when the shop is not as the edits expect", async () => {
    const [incident] = await loadIncidents();
    if (incident === undefined) throw new Error("no incidents");
    const wrong = {
      edits: incident.edits.map((edit) => ({ ...edit, find: ["a line that is not there"] })),
    };
    await expect(materialiseIncident(target, wrong)).rejects.toBeInstanceOf(EditError);
  });

  it("does not touch the shop it copies from", async () => {
    const before = await treeHash(SHOP_DIRECTORY.replace(/\/$/, ""));
    for (const incident of await loadIncidents()) {
      await materialiseIncident(join(target, "..", incident.id), incident);
    }
    expect(await treeHash(SHOP_DIRECTORY.replace(/\/$/, ""))).toBe(before);
  });
});
