import { describe, expect, it } from "vitest";
import { isParsed, languageOf, roleOf } from "./languages.js";

describe("languageOf", () => {
  it.each([
    ["src/a.ts", "typescript"],
    ["src/a.tsx", "typescript"],
    ["src/a.mts", "typescript"],
    ["a.js", "javascript"],
    ["a.mjs", "javascript"],
    ["a.cjs", "javascript"],
    ["a.jsx", "javascript"],
    ["package.json", "json"],
    ["README.md", "markdown"],
    ["ci.yml", "yaml"],
    ["ci.yaml", "yaml"],
    ["a.toml", "toml"],
    ["a.sql", "sql"],
    ["a.py", "python"],
    ["a.go", "go"],
    ["a.rs", "rust"],
    ["a.java", "java"],
    ["a.sh", "shell"],
    ["a.css", "css"],
    ["a.html", "html"],
    ["Dockerfile", "dockerfile"],
    ["docker/Dockerfile.api", "dockerfile"],
    ["a.unknown", "other"],
    ["noextension", "other"],
    [".gitignore", "other"],
    ["UPPER.TS", "typescript"],
  ])("%s is %s", (path, language) => {
    expect(languageOf(path)).toBe(language);
  });
});

describe("isParsed", () => {
  it("parses the syntax of TypeScript and JavaScript, and nothing else", () => {
    for (const path of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs"]) {
      expect(isParsed(path), path).toBe(true);
    }
    for (const path of ["a.json", "a.py", "a.md", "ts", ".ts", "dir/.js", "a.d", "a.tsx.map"]) {
      expect(isParsed(path), path).toBe(false);
    }
  });
});

describe("roleOf", () => {
  const role = (path: string): string => roleOf(path, languageOf(path));

  it("calls a file a test by its name or by where it is", () => {
    expect(role("src/a.test.ts")).toBe("test");
    expect(role("src/a.spec.js")).toBe("test");
    expect(role("src/__tests__/a.ts")).toBe("test");
    expect(role("tests/a.ts")).toBe("test");
    expect(role("test/a.py")).toBe("test");
    expect(role("e2e/a.ts")).toBe("test");
  });

  it("does not call a document or a data file in a test directory a test", () => {
    expect(role("tests/README.md")).toBe("docs");
    expect(role("tests/data.json")).toBe("data");
  });

  it("calls configuration by its name", () => {
    for (const path of [
      "package.json",
      "pkg/package.json",
      "tsconfig.json",
      "tsconfig.build.json",
      "vite.config.ts",
      "Dockerfile",
      ".github/ci.yml",
      "a.toml",
      ".eslintrc",
    ]) {
      expect(role(path), path).toBe("config");
    }
  });

  it("calls code source, documents docs, other JSON data, and the rest other", () => {
    expect(role("src/a.ts")).toBe("source");
    expect(role("src/a.py")).toBe("source");
    expect(role("docs/a.md")).toBe("docs");
    expect(role("data/a.json")).toBe("data");
    expect(role("a.png")).toBe("other");
  });

  it("does not take a name that only has 'test' in it for a test", () => {
    expect(role("src/contest.ts")).toBe("source");
    expect(role("src/attest.js")).toBe("source");
  });
});
