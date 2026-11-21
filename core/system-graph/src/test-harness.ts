import {
  repositoryFactsSchema,
  type DependencyFact,
  type EnvVarFact,
  type FrameworkFact,
  type ImportFact,
  type PackageFact,
  type RepositoryFacts,
  type RouteFact,
} from "@codemugs/application-intelligence";

/**
 * Facts for tests, made by hand and checked against the real schema, so that a fixture can never
 * drift from what the analysis can say. The graph's tests do not run the analyser: they hand it
 * what the analyser could have said.
 */

export interface FactsSpec {
  readonly files: readonly (string | { path: string; role?: "source" | "test" | "config" })[];
  readonly packages?: readonly PackageFact[];
  readonly imports?: readonly ImportFact[];
  readonly envVars?: readonly EnvVarFact[];
  readonly routes?: readonly RouteFact[];
  readonly frameworks?: readonly FrameworkFact[];
  readonly truncated?: readonly RepositoryFacts["limits"]["truncated"][number][];
}

export function makeFacts(spec: FactsSpec): RepositoryFacts {
  const files = spec.files.map((file) => {
    const path = typeof file === "string" ? file : file.path;
    const role = typeof file === "string" ? undefined : file.role;
    const json = path.endsWith(".json");
    return {
      path,
      language: json ? ("json" as const) : ("typescript" as const),
      role: role ?? (json ? ("config" as const) : ("source" as const)),
      bytes: 100,
      lines: 10,
    };
  });
  return repositoryFactsSchema.parse({
    version: 1,
    analyser: { name: "codemugs-ts-analyser", typescript: "6.0.3" },
    limits: {
      filesSeen: files.length,
      filesListed: files.length,
      filesParsed: files.length,
      bytesRead: files.length * 100,
      truncated: [...(spec.truncated ?? [])],
      skipped: {
        symlink: 0,
        tooLarge: 0,
        unreadable: 0,
        ignoredDirectory: 0,
        badName: 0,
        parseFailed: 0,
        invalidSpecifier: 0,
      },
    },
    files,
    packages: spec.packages ?? [],
    imports: spec.imports ?? [],
    envVars: spec.envVars ?? [],
    routes: spec.routes ?? [],
    frameworks: spec.frameworks ?? [],
  });
}

export function importOf(
  from: string,
  specifier: string,
  target: ImportFact["target"],
  line = 1,
  kind: ImportFact["kind"] = "static",
): ImportFact {
  return { from, specifier, kind, target, line };
}

export function packageOf(
  directory: string,
  name: string | undefined,
  dependencies: readonly DependencyFact[] = [],
): PackageFact {
  return {
    directory,
    ...(name === undefined ? {} : { name }),
    dependencies: [...dependencies],
    scripts: [],
  };
}

/** A small monorepo: an API that uses a database package, with routes, variables and frameworks. */
export function shopFacts(): RepositoryFacts {
  return makeFacts({
    files: [
      "package.json",
      "README.md",
      "apps/api/package.json",
      "apps/api/src/server.ts",
      "apps/api/src/routes.ts",
      { path: "apps/api/src/server.test.ts", role: "test" },
      "packages/db/package.json",
      "packages/db/src/index.ts",
      "packages/db/src/client.ts",
    ],
    packages: [
      { ...packageOf(".", "shop"), private: true },
      packageOf("apps/api", "@shop/api", [
        { name: "@shop/db", kind: "runtime", source: "workspace" },
        { name: "express", kind: "runtime", source: "registry", range: "^4.19.0" },
        { name: "vitest", kind: "dev", source: "registry", range: "^3.0.0" },
        { name: "@shop/api", kind: "dev", source: "workspace" },
      ]),
      packageOf("packages/db", "@shop/db", [
        { name: "pg", kind: "runtime", source: "registry", range: "^8.0.0" },
        { name: "pg", kind: "peer", source: "registry", range: ">=8" },
      ]),
    ],
    imports: [
      importOf(
        "apps/api/src/server.ts",
        "./routes.js",
        {
          type: "internal",
          path: "apps/api/src/routes.ts",
        },
        3,
      ),
      importOf("apps/api/src/server.ts", "express", { type: "package", name: "express" }, 1),
      importOf("apps/api/src/server.ts", "http", { type: "builtin", name: "http" }, 2),
      importOf("apps/api/src/server.ts", "@shop/db", { type: "package", name: "@shop/db" }, 4),
      importOf("apps/api/src/server.ts", "./generated.js", { type: "unresolved" }, 9, "dynamic"),
      importOf(
        "apps/api/src/routes.ts",
        "../../../packages/db/src/index.js",
        {
          type: "internal",
          path: "packages/db/src/index.ts",
        },
        1,
      ),
      importOf(
        "packages/db/src/index.ts",
        "./client.js",
        {
          type: "internal",
          path: "packages/db/src/client.ts",
        },
        5,
        "type",
      ),
      importOf(
        "packages/db/src/index.ts",
        "./client.js",
        {
          type: "internal",
          path: "packages/db/src/client.ts",
        },
        1,
        "static",
      ),
      importOf("packages/db/src/client.ts", "pg", { type: "package", name: "pg" }, 1),
      importOf(
        "apps/api/src/server.test.ts",
        "./server.js",
        {
          type: "internal",
          path: "apps/api/src/server.ts",
        },
        1,
      ),
      importOf("apps/api/src/server.test.ts", "vitest", { type: "package", name: "vitest" }, 2),
    ],
    envVars: [
      {
        name: "DATABASE_URL",
        reads: 3,
        files: ["apps/api/src/server.ts", "packages/db/src/client.ts"],
      },
      { name: "PORT", reads: 1, files: ["apps/api/src/server.ts"] },
    ],
    routes: [
      {
        method: "GET",
        path: "/products",
        file: "apps/api/src/routes.ts",
        line: 10,
        style: "router",
        confidence: "high",
      },
      {
        method: "POST",
        path: "/orders",
        file: "apps/api/src/routes.ts",
        line: 20,
        style: "router",
        confidence: "high",
      },
      {
        method: "GET",
        path: "/health",
        file: "apps/api/src/server.ts",
        line: 5,
        style: "http",
        confidence: "heuristic",
      },
    ],
    frameworks: [
      {
        name: "express",
        category: "web",
        evidence: "dependency",
        usedIn: 1,
        files: ["apps/api/package.json"],
      },
      {
        name: "express",
        category: "web",
        evidence: "import",
        usedIn: 1,
        files: ["apps/api/src/server.ts"],
      },
      {
        name: "vitest",
        category: "test",
        evidence: "import",
        usedIn: 1,
        files: ["apps/api/src/server.test.ts"],
      },
    ],
  });
}

/**
 * The largest answer that the analysis can give, with every list at its limit, and with as many
 * different things as the limits allow, so that it makes the most nodes and the most edges that a
 * run can have:
 *
 * - 20,000 files, of which 1,000 are package.json files, one for each of 1,000 packages, and the
 *   others are source files that are in a package (an `in_package` edge each);
 * - 100,000 dependencies, a hundred for each package, each of a name of its own (a module and a
 *   `depends_on` edge each);
 * - 100,000 imports of modules, each of a name of its own (a module and an `imports` edge each);
 * - 2,000 variables, each read in 20 files; 5,000 routes; 200 frameworks, each in 20 files.
 *
 * Nothing in it is the same as anything else, so no edge is made of two facts and no node is shared.
 */
export const LARGEST_RUN = Object.freeze({
  nodes: 20_000 + 1_000 + 100_000 + 100_000 + 2_000 + 5_000 + 200,
  edges: 100_000 + 20_000 + 100_000 + 2_000 * 20 + 5_000 + 200 * 20,
});

export function largestFacts(): RepositoryFacts {
  const packages = 1_000;
  const sourcesPerPackage = 19;
  const id = (number: number): string => String(number).padStart(4, "0");
  const directory = (number: number): string => `pkg/p${id(number)}`;
  const sources: string[] = [];
  const files: string[] = [];
  for (let number = 0; number < packages; number += 1) {
    files.push(`${directory(number)}/package.json`);
    for (let source = 0; source < sourcesPerPackage; source += 1) {
      const path = `${directory(number)}/src/m${String(source)}.ts`;
      files.push(path);
      sources.push(path);
    }
  }
  const sourceAt = (index: number): string => sources[index % sources.length] ?? "";
  const filesAt = (index: number, count: number): string[] =>
    Array.from({ length: count }, (_, offset) => sourceAt(index * 7 + offset));

  return makeFacts({
    files,
    packages: Array.from({ length: packages }, (_, number) =>
      packageOf(
        directory(number),
        `big-p${id(number)}`,
        Array.from({ length: 100 }, (_, dependency) => ({
          name: `dep-${id(number)}-${String(dependency)}`,
          kind: "runtime" as const,
          source: "registry" as const,
          range: "^1.0.0",
        })),
      ),
    ),
    imports: Array.from({ length: 100_000 }, (_, index) =>
      importOf(
        sourceAt(index),
        `imp-${String(index)}`,
        { type: "package", name: `imp-${String(index)}` },
        (index % 500) + 1,
      ),
    ),
    envVars: Array.from({ length: 2_000 }, (_, index) => ({
      name: `VAR_${String(index)}`,
      reads: 20,
      files: filesAt(index, 20),
    })),
    routes: Array.from({ length: 5_000 }, (_, index) => ({
      method: "GET" as const,
      path: `/r${String(index)}`,
      file: sourceAt(index),
      line: (index % 500) + 1,
      style: "router" as const,
      confidence: "high" as const,
    })),
    frameworks: Array.from({ length: 200 }, (_, index) => ({
      name: `framework-${String(index)}`,
      category: "web" as const,
      evidence: "import" as const,
      usedIn: 20,
      files: filesAt(index + 5, 20),
    })),
  });
}
