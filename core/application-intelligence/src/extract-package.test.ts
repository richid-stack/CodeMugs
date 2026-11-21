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
    const fact = extractPackage("packages/thing", JSON.stringify(manifest), limits)?.fact;
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
    const text = JSON.stringify(extractPackage(".", JSON.stringify(manifest), limits)?.fact);
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
    )?.fact;
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
    )?.fact;
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
    )?.fact;
    expect(fact?.dependencies).toHaveLength(4);
    expect(fact?.dependencies.every((dependency) => dependency.kind === "runtime")).toBe(true);
    expect(fact?.scripts).toEqual(["script-0", "script-1", "script-2"]);
  });

  it("does not take a key such as __proto__ for a dependency of the object", () => {
    const fact = extractPackage(
      ".",
      '{"dependencies":{"__proto__":"1.0.0","constructor":"1.0.0","ok":"1.0.0"}}',
      limits,
    )?.fact;
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(fact?.dependencies.map((dependency) => dependency.name)).toEqual(["constructor", "ok"]);
  });
  describe("when it leaves a dependency out because of a limit", () => {
    const dependencies = (count: number): Record<string, string> =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`dep-${String(index)}`, "1.0.0"]),
      );
    const text = (count: number): string => JSON.stringify({ dependencies: dependencies(count) });

    it("says so, and keeps the first of them in the order of the manifest's sorted names", () => {
      const small = resolveLimits({ maxDependenciesPerPackage: 3 });
      const result = extractPackage(".", text(5), small);
      expect(result?.cut).toBe(true);
      expect(result?.fact.dependencies.map((dependency) => dependency.name)).toEqual([
        "dep-0",
        "dep-1",
        "dep-2",
      ]);
    });

    it("does not say so when the dependencies are as many as the limit and no more", () => {
      const small = resolveLimits({ maxDependenciesPerPackage: 3 });
      expect(extractPackage(".", text(3), small)?.cut).toBe(false);
      expect(extractPackage(".", text(2), small)?.cut).toBe(false);
      expect(extractPackage(".", text(4), small)?.cut).toBe(true);
    });

    it("does not say so for an entry that it would have left out anyway", () => {
      const small = resolveLimits({ maxDependenciesPerPackage: 1 });
      const result = extractPackage(
        ".",
        JSON.stringify({ dependencies: { good: "1.0.0", "Bad Name": "1.0.0", number: 1 } }),
        small,
      );
      expect(result?.cut).toBe(false);
      expect(result?.fact.dependencies).toHaveLength(1);
    });

    it("says so when the dependencies of a later kind are the ones that do not fit", () => {
      const small = resolveLimits({ maxDependenciesPerPackage: 2 });
      const result = extractPackage(
        ".",
        JSON.stringify({
          dependencies: { a: "1.0.0", b: "1.0.0" },
          devDependencies: { c: "1.0.0" },
        }),
        small,
      );
      expect(result?.cut).toBe(true);
      expect(result?.fact.dependencies.map((dependency) => dependency.name)).toEqual(["a", "b"]);
    });

    it("keeps no more than the room it is given, which is the part of the total that is left", () => {
      const result = extractPackage(".", text(5), limits, 2);
      expect(result?.cut).toBe(true);
      expect(result?.fact.dependencies.map((dependency) => dependency.name)).toEqual([
        "dep-0",
        "dep-1",
      ]);
      expect(extractPackage(".", text(5), limits, 5)?.cut).toBe(false);
    });

    it("keeps the package, with none of its dependencies, when there is no room at all", () => {
      const result = extractPackage(
        ".",
        JSON.stringify({ name: "kept", dependencies: { a: "1" } }),
        limits,
        0,
      );
      expect(result?.cut).toBe(true);
      expect(result?.fact).toEqual({ directory: ".", name: "kept", dependencies: [], scripts: [] });
    });

    it("takes a fraction of room for no room, and rounds a limit that is a fraction down", () => {
      const result = extractPackage(".", text(5), limits, 0.5);
      expect(result?.cut).toBe(true);
      expect(result?.fact.dependencies).toEqual([]);
      expect(extractPackage(".", text(5), limits, 2.9)?.fact.dependencies).toHaveLength(2);
      const fraction = resolveLimits({ maxDependenciesPerPackage: 1.5 });
      expect(extractPackage(".", text(5), fraction)?.fact.dependencies).toHaveLength(1);
    });

    it("is held to the limit over all the packages when it is given no room", () => {
      const small = resolveLimits({ maxDependencies: 2 });
      const result = extractPackage(".", text(5), small);
      expect(result?.cut).toBe(true);
      expect(result?.fact.dependencies).toHaveLength(2);
    });

    it("is never more than the limit of one package, whatever the room", () => {
      const small = resolveLimits({ maxDependenciesPerPackage: 2 });
      expect(extractPackage(".", text(5), small, 100)?.fact.dependencies).toHaveLength(2);
    });
  });
});
