import { describe, expect, it } from "vitest";
import { classifyDependency, extractPackage } from "./extract-package.js";
import { resolveLimits } from "./limits.js";

const limits = resolveLimits();

describe("classifyDependency", () => {
  it.each([
    ["^1.2.3", { source: "registry", range: "^1.2.3" }],
    ["~1.2", { source: "registry", range: "~1.2" }],
    [">=1.0.0 <2.0.0", { source: "registry", range: ">=1.0.0 <2.0.0" }],
    ["1.x || 2.x", { source: "registry", range: "1.x || 2.x" }],
    ["*", { source: "registry", range: "*" }],
    ["latest", { source: "registry", range: "latest" }],
    ["workspace:*", { source: "workspace" }],
    ["workspace:^1.0.0", { source: "workspace" }],
    ["npm:other@^2", { source: "alias" }],
    ["file:../local", { source: "file" }],
    ["link:../local", { source: "file" }],
    ["portal:../local", { source: "file" }],
    ["git+https://user:token@example.com/org/repo.git", { source: "git" }],
    ["git+ssh://git@example.com/org/repo.git#main", { source: "git" }],
    ["git://example.com/org/repo.git", { source: "git" }],
    ["github:org/repo", { source: "git" }],
    ["gitlab:org/repo", { source: "git" }],
    ["git@example.com:org/repo.git", { source: "git" }],
    ["org/repo", { source: "git" }],
    ["org/repo#semver:^1", { source: "git" }],
    ["https://user:token@example.com/pkg.tgz", { source: "url" }],
    ["http://example.com/pkg.tgz", { source: "url" }],
  ])("%s", (spec, expected) => {
    expect(classifyDependency(spec)).toEqual(expected);
  });

  it("keeps no range that is not written as one, and none that is long", () => {
    expect(classifyDependency("1.0.0\n$(touch x)")).toEqual({ source: "registry" });
    expect(classifyDependency("^1.0.0;rm")).toEqual({ source: "registry" });
    expect(classifyDependency(`^${"1".repeat(200)}`)).toEqual({ source: "registry" });
  });

  it("never gives the text of a source that can hold a token", () => {
    for (const spec of [
      "git+https://user:s3cr3t-token@example.com/org/repo.git",
      "https://user:s3cr3t-token@example.com/pkg.tgz",
      "git@example.com:org/s3cr3t-token.git",
      "file:../s3cr3t-token",
    ]) {
      expect(JSON.stringify(classifyDependency(spec))).not.toContain("s3cr3t");
    }
  });
});

describe("extractPackage", () => {
  const manifest = {
    name: "@scope/thing",
    version: "1.2.3-beta.1",
    private: true,
    type: "module",
    scripts: {
      build: "tsc && node ./secret-build.js",
      test: "vitest run",
      "db:migrate": "node m.js",
    },
    dependencies: {
      zod: "4.6.7",
      "@codemugs/jobs": "workspace:*",
      fork: "git+https://u:tok@h/r.git",
    },
    devDependencies: { vitest: "^5.1.0" },
    peerDependencies: { react: ">=18" },
    optionalDependencies: { fsevents: "2.3.3" },
  };

  it("reads the name, the version, the module type, the dependencies and the names of scripts", () => {
    const fact = extractPackage("packages/thing", JSON.stringify(manifest), limits);
    expect(fact).toEqual({
      directory: "packages/thing",
      name: "@scope/thing",
      version: "1.2.3-beta.1",
      private: true,
      moduleType: "module",
      dependencies: [
        { name: "@codemugs/jobs", kind: "runtime", source: "workspace" },
        { name: "fork", kind: "runtime", source: "git" },
        { name: "zod", kind: "runtime", source: "registry", range: "4.6.7" },
        { name: "vitest", kind: "dev", source: "registry", range: "^5.1.0" },
        { name: "react", kind: "peer", source: "registry", range: ">=18" },
        { name: "fsevents", kind: "optional", source: "registry", range: "2.3.3" },
      ],
      scripts: ["build", "db:migrate", "test"],
    });
  });

  it("never keeps what a script runs, or the text of a source that can hold a token", () => {
    const text = JSON.stringify(extractPackage(".", JSON.stringify(manifest), limits));
    expect(text).not.toContain("secret-build");
    expect(text).not.toContain("tsc &&");
    expect(text).not.toContain("tok@");
    expect(text).not.toContain("git+https");
  });

  it("is not a package when the text is not JSON, or not an object", () => {
    for (const text of ["", "not json", "[1,2]", "null", '"text"', "42", "{"]) {
      expect(extractPackage(".", text, limits), text).toBeNull();
    }
  });

  it("leaves out what is not of the kind it expects, and does not guess", () => {
    const fact = extractPackage(
      ".",
      JSON.stringify({
        name: 42,
        version: "not a version!",
        private: "yes",
        type: "other",
        scripts: ["a", "b"],
        dependencies: { good: "1.0.0", "Bad Name": "1.0.0", number: 1, nested: { a: 1 } },
        devDependencies: "text",
      }),
      limits,
    );
    expect(fact).toEqual({
      directory: ".",
      dependencies: [{ name: "good", kind: "runtime", source: "registry", range: "1.0.0" }],
      scripts: [],
    });
  });

  it("leaves out a name that the facts cannot carry", () => {
    const fact = extractPackage(
      ".",
      JSON.stringify({ name: "UPPER", scripts: { "bad script": "x", fine: "y", "a\nb": "z" } }),
      limits,
    );
    expect(fact?.name).toBeUndefined();
    expect(fact?.scripts).toEqual(["fine"]);
  });

  it("keeps no more dependencies or scripts than the limits allow", () => {
    const dependencies = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`dep-${String(index)}`, "1.0.0"]),
    );
    const scripts = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`script-${String(index)}`, "x"]),
    );
    const small = resolveLimits({ maxDependenciesPerPackage: 4, maxScriptsPerPackage: 3 });
    const fact = extractPackage(
      ".",
      JSON.stringify({ dependencies, devDependencies: dependencies, scripts }),
      small,
    );
    expect(fact?.dependencies).toHaveLength(4);
    expect(fact?.dependencies.every((dependency) => dependency.kind === "runtime")).toBe(true);
    expect(fact?.scripts).toEqual(["script-0", "script-1", "script-2"]);
  });

  it("does not take a key such as __proto__ for a dependency of the object", () => {
    const fact = extractPackage(
      ".",
      '{"dependencies":{"__proto__":"1.0.0","constructor":"1.0.0","ok":"1.0.0"}}',
      limits,
    );
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(fact?.dependencies.map((dependency) => dependency.name)).toEqual(["constructor", "ok"]);
  });
});
