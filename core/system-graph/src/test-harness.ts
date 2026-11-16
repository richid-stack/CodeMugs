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
