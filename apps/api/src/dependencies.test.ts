import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ADR 0034: the API records and reads rows. The image is built with `pnpm deploy --prod`, so
// whatever the API depends on, directly or through another package of this repository, is in
// the image. Nothing that reads a repository, runs the analyser or reaches the sandbox may be.

const apiDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
}

function manifestOf(directory: string): Manifest {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Manifest;
}

/** The names of everything that a package needs to run, through the packages of this repository. */
function closure(directory: string, found = new Map<string, string>()): Set<string> {
  for (const name of Object.keys(manifestOf(directory).dependencies ?? {})) {
    if (found.has(name)) continue;
    const linked = join(directory, "node_modules", name);
    // A package of this repository is linked into node_modules; others are only named.
    const target = existsSync(linked) ? realpathSync(linked) : undefined;
    found.set(name, target ?? "");
    if (name.startsWith("@codemugs/") && target !== undefined) closure(target, found);
  }
  return new Set(found.keys());
}

const FORBIDDEN = [
  "typescript",
  "@codemugs/application-intelligence",
  "@codemugs/archive",
  "@codemugs/github",
  "@codemugs/sandbox-manager",
  "@codemugs/system-graph",
];

describe("what the API image holds", () => {
  it("has no analyser, archive reader or sandbox manager among its dependencies", () => {
    const needed = closure(apiDirectory);
    // The walk reaches what it should: the package that the routes use, and what that needs.
    expect(needed).toContain("@codemugs/repository-analysis");
    expect(needed).toContain("@codemugs/jobs");
    expect(needed).toContain("fastify");

    expect([...needed].filter((name) => FORBIDDEN.includes(name))).toEqual([]);
  });

  it("would notice one: the graph package brings the analyser with it", () => {
    const graph = closure(join(apiDirectory, "..", "..", "core", "system-graph"));
    expect(graph).toContain("@codemugs/application-intelligence");
    expect(graph).toContain("typescript");
    expect(graph).toContain("@codemugs/sandbox-manager");
  });
});
