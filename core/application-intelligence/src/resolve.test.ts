import { describe, expect, it } from "vitest";
import { packageOfSpecifier, resolveSpecifier } from "./resolve.js";

const files = new Set([
  "src/a.ts",
  "src/b.ts",
  "src/c.tsx",
  "src/data.json",
  "src/util/index.ts",
  "src/legacy.js",
  "src/mod.mts",
  "index.ts",
  "lib/x.cjs",
  "lib/y.js",
]);

const resolve = (from: string, specifier: string): unknown =>
  resolveSpecifier(from, specifier, files);
const internal = (path: string): unknown => ({ type: "internal", path });

describe("resolveSpecifier, relative", () => {
  it("finds a file by the name as it is written, or with an extension", () => {
    expect(resolve("src/a.ts", "./b.ts")).toEqual(internal("src/b.ts"));
    expect(resolve("src/a.ts", "./b")).toEqual(internal("src/b.ts"));
    expect(resolve("src/a.ts", "./c")).toEqual(internal("src/c.tsx"));
    expect(resolve("src/a.ts", "./data.json")).toEqual(internal("src/data.json"));
    expect(resolve("src/a.ts", "./legacy")).toEqual(internal("src/legacy.js"));
  });

  it("reads an extension of JavaScript as the extension of the TypeScript that it was built from", () => {
    expect(resolve("src/a.ts", "./b.js")).toEqual(internal("src/b.ts"));
    expect(resolve("src/a.ts", "./c.jsx")).toEqual(internal("src/c.tsx"));
    expect(resolve("src/a.ts", "./c.js")).toEqual(internal("src/c.tsx"));
    expect(resolve("src/a.ts", "./mod.mjs")).toEqual(internal("src/mod.mts"));
    expect(resolve("src/a.ts", "./legacy.js")).toEqual(internal("src/legacy.js"));
  });

  it("prefers the file that is named to the one it could be", () => {
    expect(resolve("lib/y.js", "./x.cjs")).toEqual(internal("lib/x.cjs"));
    expect(resolve("src/a.ts", "./legacy.js")).toEqual(internal("src/legacy.js"));
  });

  it("finds the index file of a directory", () => {
    expect(resolve("src/a.ts", "./util")).toEqual(internal("src/util/index.ts"));
    expect(resolve("src/a.ts", "./util/")).toEqual(internal("src/util/index.ts"));
    expect(resolve("src/util/index.ts", ".")).toEqual(internal("src/util/index.ts"));
    expect(resolve("src/a.ts", ".")).toEqual({ type: "unresolved" });
    expect(resolve("src/util/index.ts", "..")).toEqual({ type: "unresolved" });
  });

  it("finds the index file of the root of the repository", () => {
    expect(resolve("other.ts", ".")).toEqual(internal("index.ts"));
    expect(resolve("other.ts", "./")).toEqual(internal("index.ts"));
  });

  it("goes up and down directories", () => {
    expect(resolve("src/util/index.ts", "../a")).toEqual(internal("src/a.ts"));
    expect(resolve("src/util/index.ts", "../../index")).toEqual(internal("index.ts"));
    expect(resolve("index.ts", "./src/a")).toEqual(internal("src/a.ts"));
    expect(resolve("src/a.ts", "./util/../b")).toEqual(internal("src/b.ts"));
  });

  it("does not leave the repository, and does not invent a file", () => {
    expect(resolve("index.ts", "../a")).toEqual({ type: "unresolved" });
    expect(resolve("src/a.ts", "../../a")).toEqual({ type: "unresolved" });
    expect(resolve("src/a.ts", "./missing")).toEqual({ type: "unresolved" });
    expect(resolve("src/a.ts", "./b.json")).toEqual({ type: "unresolved" });
  });
});

describe("resolveSpecifier, not relative", () => {
  it("names the package of a bare specifier", () => {
    expect(resolve("src/a.ts", "zod")).toEqual({ type: "package", name: "zod" });
    expect(resolve("src/a.ts", "zod/v4")).toEqual({ type: "package", name: "zod" });
    expect(resolve("src/a.ts", "@codemugs/jobs")).toEqual({
      type: "package",
      name: "@codemugs/jobs",
    });
    expect(resolve("src/a.ts", "@codemugs/jobs/sub/path")).toEqual({
      type: "package",
      name: "@codemugs/jobs",
    });
  });

  it("names a built-in module, with or without the prefix", () => {
    expect(resolve("src/a.ts", "node:fs")).toEqual({ type: "builtin", name: "fs" });
    expect(resolve("src/a.ts", "node:fs/promises")).toEqual({
      type: "builtin",
      name: "fs/promises",
    });
    expect(resolve("src/a.ts", "node:test")).toEqual({ type: "builtin", name: "test" });
    expect(resolve("src/a.ts", "fs")).toEqual({ type: "builtin", name: "fs" });
    expect(resolve("src/a.ts", "path")).toEqual({ type: "builtin", name: "path" });
    expect(resolve("src/a.ts", "fs/promises")).toEqual({ type: "builtin", name: "fs/promises" });
  });

  it("does not take a package that starts like a built-in for one", () => {
    expect(resolve("src/a.ts", "fs-extra")).toEqual({ type: "package", name: "fs-extra" });
    expect(resolve("src/a.ts", "fs/nothing-of-node")).toEqual({ type: "package", name: "fs" });
  });

  it("does not name a package whose name is longer than a package name can be", () => {
    expect(resolve("src/a.ts", "a".repeat(214))).toEqual({
      type: "package",
      name: "a".repeat(214),
    });
    expect(resolve("src/a.ts", "a".repeat(215))).toEqual({ type: "unresolved" });
  });

  it("does not resolve what is not a package or a file", () => {
    for (const specifier of [
      "#internal/thing",
      "/absolute/path",
      "https://example.com/x.js",
      "file:///etc/passwd",
      "data:text/javascript,1",
      "node:",
      "node:NOT-A-NAME",
      "UpperCase",
      "@scope",
      "@/x",
      "a b",
    ]) {
      expect(resolve("src/a.ts", specifier), specifier).toEqual({ type: "unresolved" });
    }
  });

  it("does not look at the disk", () => {
    expect(resolveSpecifier("src/a.ts", "./b", new Set())).toEqual({ type: "unresolved" });
  });
});

describe("packageOfSpecifier", () => {
  it.each([
    ["a", "a"],
    ["a/b/c", "a"],
    ["@s/a", "@s/a"],
    ["@s/a/b", "@s/a"],
    ["@s", undefined],
    ["@", undefined],
    ["@/a", undefined],
    ["", undefined],
    ["/a", undefined],
  ])("%j is %j", (specifier, name) => {
    expect(packageOfSpecifier(specifier)).toBe(name);
  });
});
