import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyse } from "./analyse.js";
import { parseRepositoryFacts, type RepositoryFacts } from "./facts.js";
import { directorySource } from "./source.js";

/** The repository that holds this package: the first application that CodeMugs understands is its own. */
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function analyseDirectory(path: string): Promise<RepositoryFacts> {
  const facts = await analyse(directorySource(path));
  // The facts have been through JSON, as they are when they leave the sandbox.
  return parseRepositoryFacts(JSON.stringify(facts));
}

describe("the demo shop", () => {
  it("is understood: its routes, its variable, its package, and how its files import each other", async () => {
    const facts = await analyseDirectory(`${repositoryRoot}tests/demo-shop`);

    expect(facts.limits.truncated).toEqual([]);
    expect(facts.limits.skipped.parseFailed).toBe(0);
    expect(facts.packages.map((entry) => entry.name)).toEqual(["@codemugs/demo-shop"]);

    const routes = facts.routes.map((route) => `${route.method} ${route.path} ${route.file}`);
    expect(routes).toEqual(
      expect.arrayContaining([
        "GET /health src/server.ts",
        "GET /products src/server.ts",
        "POST /orders src/server.ts",
      ]),
    );
    // A server of the standard library is found by what it compares, which is a heuristic.
    expect(facts.routes.every((route) => route.confidence === "heuristic")).toBe(true);

    expect(facts.envVars).toEqual([{ name: "PORT", reads: 1, files: ["src/main.ts"] }]);

    const internal = facts.imports.filter((entry) => entry.target.type === "internal");
    expect(internal.length).toBeGreaterThan(0);
    expect(facts.imports.filter((entry) => entry.target.type === "unresolved")).toEqual([]);
    expect(
      internal.some(
        (entry) =>
          entry.from === "src/main.ts" &&
          entry.target.type === "internal" &&
          entry.target.path === "src/shop.ts",
      ),
    ).toBe(true);
  });
});

describe("CodeMugs itself", () => {
  it("is understood: its packages, its routes, and nothing that the parser fails on", async () => {
    const facts = await analyseDirectory(repositoryRoot);

    expect(facts.limits.truncated).toEqual([]);
    expect(facts.limits.skipped.parseFailed).toBe(0);
    expect(facts.limits.skipped.symlink).toBe(0);
    expect(facts.limits.filesParsed).toBeGreaterThan(100);

    const directories = facts.packages.map((entry) => entry.directory);
    expect(directories).toEqual(
      expect.arrayContaining([
        ".",
        "apps/api",
        "apps/worker",
        "packages/jobs",
        "packages/storage",
        "core/application-intelligence",
      ]),
    );
    expect(directories).toEqual([...directories].sort());

    expect(
      facts.routes.some(
        (route) =>
          route.method === "GET" && route.path === "/healthz" && route.file.startsWith("apps/api/"),
      ),
    ).toBe(true);

    expect(
      facts.imports.some(
        (entry) =>
          entry.from === "core/application-intelligence/src/analyse.ts" &&
          entry.target.type === "internal" &&
          entry.target.path === "core/application-intelligence/src/extract-code.ts",
      ),
    ).toBe(true);
    expect(
      facts.imports.some(
        (entry) => entry.target.type === "package" && entry.target.name === "@codemugs/jobs",
      ),
    ).toBe(true);
  }, 60_000);

  it("holds no file that the analysis lists from a directory that is never the repository's own", async () => {
    const facts = await analyseDirectory(repositoryRoot);
    const inside = facts.files.filter((file) =>
      file.path
        .split("/")
        .some((part) => part === "node_modules" || part === ".git" || part === "dist"),
    );
    expect(inside).toEqual([]);
  }, 60_000);
});
