import { describe, expect, it } from "vitest";
import { ANALYSER_NAME, ANALYSIS_LIMITS, FACTS_VERSION } from "./constants.js";
import {
  FactsRejected,
  parseRepositoryFacts,
  repositoryFactsSchema,
  repositoryPath,
  type RepositoryFacts,
} from "./facts.js";

function valid(): RepositoryFacts {
  return {
    version: FACTS_VERSION,
    analyser: { name: ANALYSER_NAME, typescript: "6.0.3" },
    limits: {
      filesSeen: 2,
      filesListed: 2,
      filesParsed: 2,
      bytesRead: 100,
      truncated: [],
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
    files: [
      { path: "src/a.ts", language: "typescript", role: "source", bytes: 60, lines: 3 },
      { path: "src/b.ts", language: "typescript", role: "source", bytes: 40, lines: 2 },
    ],
    packages: [
      {
        directory: ".",
        name: "thing",
        version: "1.0.0",
        private: true,
        moduleType: "module",
        dependencies: [{ name: "zod", kind: "runtime", source: "registry", range: "^4.0.0" }],
        scripts: ["build"],
      },
    ],
    imports: [
      {
        from: "src/a.ts",
        specifier: "./b.js",
        kind: "static",
        target: { type: "internal", path: "src/b.ts" },
        line: 1,
      },
      {
        from: "src/a.ts",
        specifier: "zod",
        kind: "static",
        target: { type: "package", name: "zod" },
        line: 2,
      },
      {
        from: "src/b.ts",
        specifier: "node:fs",
        kind: "static",
        target: { type: "builtin", name: "fs" },
        line: 1,
      },
      {
        from: "src/b.ts",
        specifier: "#x",
        kind: "dynamic",
        target: { type: "unresolved" },
        line: 2,
      },
    ],
    envVars: [{ name: "PORT", reads: 1, files: ["src/a.ts"] }],
    routes: [
      {
        method: "GET",
        path: "/health",
        file: "src/a.ts",
        line: 3,
        style: "router",
        confidence: "high",
      },
    ],
    frameworks: [
      { name: "express", category: "web", evidence: "import", usedIn: 1, files: ["src/a.ts"] },
    ],
  };
}

type Key = string | number;
type Edit = readonly [path: readonly Key[], value: unknown];

/** A copy of the valid document, with each value set at its path. A path that does not exist is made. */
function changed(...edits: Edit[]): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(valid()));
  for (const [path, value] of edits) {
    let target = copy as Record<Key, unknown>;
    for (const key of path.slice(0, -1)) {
      target = target[key] as Record<Key, unknown>;
    }
    const last = path[path.length - 1];
    if (last === undefined) throw new Error("an edit needs a path");
    target[last] = value;
  }
  return copy;
}

const accepts = (value: unknown): boolean => repositoryFactsSchema.safeParse(value).success;

const emptied: Edit[] = [
  [["files"], []],
  [["packages"], []],
  [["imports"], []],
  [["envVars"], []],
  [["routes"], []],
  [["frameworks"], []],
];

function fileList(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `f${String(index)}`,
    language: "other",
    role: "other",
    bytes: 0,
    lines: 0,
  }));
}

describe("the facts schema", () => {
  it("accepts a document that agrees with itself", () => {
    expect(accepts(valid())).toBe(true);
  });

  it("accepts a document with nothing in it", () => {
    expect(accepts(changed(...emptied, [["limits", "filesListed"], 0]))).toBe(true);
  });

  it("refuses a key that it does not know, at every level", () => {
    const places: (readonly Key[])[] = [
      ["extra"],
      ["analyser", "extra"],
      ["limits", "extra"],
      ["limits", "skipped", "extra"],
      ["files", 0, "extra"],
      ["packages", 0, "extra"],
      ["packages", 0, "dependencies", 0, "extra"],
      ["imports", 0, "extra"],
      ["imports", 0, "target", "extra"],
      ["imports", 1, "target", "extra"],
      ["imports", 2, "target", "extra"],
      ["imports", 3, "target", "extra"],
      ["envVars", 0, "extra"],
      ["routes", 0, "extra"],
      ["frameworks", 0, "extra"],
    ];
    for (const place of places) {
      expect(accepts(changed([place, 1])), place.join(".")).toBe(false);
    }
  });

  it("refuses a version or an analyser that it does not know", () => {
    expect(accepts(changed([["version"], 2]))).toBe(false);
    expect(accepts(changed([["analyser", "name"], "other"]))).toBe(false);
    expect(accepts(changed([["analyser", "typescript"], "x".repeat(33)]))).toBe(false);
  });

  it("refuses a field of the wrong kind, and a number that is not a count", () => {
    for (const bytes of [-1, 1.5, "1", null, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(accepts(changed([["files", 0, "bytes"], bytes])), String(bytes)).toBe(false);
    }
    expect(accepts(changed([["files", 0, "language"], "cobol"]))).toBe(false);
    expect(accepts(changed([["files", 0, "role"], "secret"]))).toBe(false);
    expect(accepts(changed([["imports", 0, "line"], 0]))).toBe(false);
    expect(accepts(changed([["limits", "truncated"], ["anything"]]))).toBe(false);
    expect(accepts(changed([["routes", 0, "method"], "TRACE"]))).toBe(false);
    expect(accepts(changed([["routes", 0, "confidence"], "certain"]))).toBe(false);
  });

  it("refuses a document that is not an object", () => {
    for (const value of [null, [], "text", 1, undefined]) {
      expect(accepts(value)).toBe(false);
    }
  });

  describe("references", () => {
    it("refuses an import from a file that is not listed", () => {
      expect(accepts(changed([["imports", 0, "from"], "src/missing.ts"]))).toBe(false);
    });

    it("refuses an import of a file of the repository that is not listed", () => {
      expect(accepts(changed([["imports", 0, "target", "path"], "src/missing.ts"]))).toBe(false);
    });

    it("refuses a route, a variable and a framework in a file that is not listed", () => {
      expect(accepts(changed([["routes", 0, "file"], "src/missing.ts"]))).toBe(false);
      expect(accepts(changed([["envVars", 0, "files"], ["src/missing.ts"]]))).toBe(false);
      expect(
        accepts(
          changed([
            ["frameworks", 0, "files"],
            ["src/a.ts", "src/missing.ts"],
          ]),
        ),
      ).toBe(false);
    });

    it("refuses a file that is listed twice, when everything that points at a file is right", () => {
      const copy = {
        path: "src/b.ts",
        language: "typescript",
        role: "source",
        bytes: 40,
        lines: 2,
      };
      expect(accepts(changed([["files", 2], copy], [["limits", "filesListed"], 3]))).toBe(false);
      expect(
        accepts(
          changed([["files", 2], { ...copy, path: "src/c.ts" }], [["limits", "filesListed"], 3]),
        ),
      ).toBe(true);
    });

    it("refuses a count of the files listed that is not the files that it lists", () => {
      expect(accepts(changed([["limits", "filesListed"], 1]))).toBe(false);
      expect(accepts(changed([["limits", "filesListed"], 3]))).toBe(false);
    });
  });

  describe("paths", () => {
    const refused = [
      "",
      "/etc/passwd",
      "../outside",
      "a/../b",
      "./a",
      "a/./b",
      "a//b",
      "a/",
      "a\\b",
      "a\nb",
      "a\u0000b",
      "a\u001bb",
      "a\u007fb",
      "a\u0085b",
      "a\u2028b",
      "a\u2029b",
      "x".repeat(ANALYSIS_LIMITS.maxPathLength + 1),
      ".",
      "..",
    ];

    it.each(refused.map((path) => [JSON.stringify(path), path] as const))(
      "refuses %s",
      (_label, path) => {
        expect(repositoryPath.safeParse(path).success).toBe(false);
      },
    );

    it("accepts the names that a repository has", () => {
      for (const path of [
        "a",
        "src/a.ts",
        ".github/workflows/ci.yml",
        "a b/c d.ts",
        "ünïcode/файл.ts",
        "x".repeat(ANALYSIS_LIMITS.maxPathLength),
      ]) {
        expect(repositoryPath.safeParse(path).success, path).toBe(true);
      }
    });
  });

  describe("names that came out of a repository", () => {
    it("refuses an environment variable name that is not one", () => {
      for (const name of ["", "1A", "A-B", "A B", "A\n", "A=B", "$(x)", "A".repeat(129)]) {
        expect(accepts(changed([["envVars", 0, "name"], name])), name).toBe(false);
      }
    });

    it("refuses a route path that has a space, a control character or no slash", () => {
      const long = `/${"a".repeat(ANALYSIS_LIMITS.maxRoutePathLength)}`;
      for (const path of ["health", "/a b", "/a\nb", "/a\u0000", "", "/é", long]) {
        expect(accepts(changed([["routes", 0, "path"], path])), path).toBe(false);
      }
    });

    it("refuses a version range that holds more than a range holds", () => {
      for (const range of ["^1.0.0;rm", "1\n2", "$(x)", "`x`", "a".repeat(101), ""]) {
        expect(accepts(changed([["packages", 0, "dependencies", 0, "range"], range])), range).toBe(
          false,
        );
      }
    });

    it("refuses a script name that holds a command", () => {
      for (const script of ["build && rm -rf /", "a b", "a\nb", "$(x)", ""]) {
        expect(accepts(changed([["packages", 0, "scripts"], [script]])), script).toBe(false);
      }
    });

    it("refuses a package name that is not one", () => {
      for (const name of ["UPPER", "a b", "../x", "@/x", "@scope", "a".repeat(215), ""]) {
        expect(accepts(changed([["packages", 0, "name"], name])), name).toBe(false);
      }
    });

    it("refuses a specifier with a control character, or one that is too long", () => {
      const long = "x".repeat(ANALYSIS_LIMITS.maxSpecifierLength + 1);
      for (const text of ["a\nb", "a\u0000b", "a\u2028b", "", long]) {
        expect(accepts(changed([["imports", 0, "specifier"], text])), text).toBe(false);
      }
    });

    it("refuses a built-in name that is not one", () => {
      expect(accepts(changed([["imports", 2, "target", "name"], "../x"]))).toBe(false);
      expect(accepts(changed([["imports", 2, "target", "name"], "a b"]))).toBe(false);
    });

    it("accepts a name of a framework that has a colon, as a built-in module does", () => {
      const framework = {
        name: "node:http",
        category: "runtime",
        evidence: "import",
        usedIn: 1,
        files: ["src/a.ts"],
      };
      expect(accepts(changed([["frameworks", 0], framework]))).toBe(true);
    });
  });

  describe("bounds", () => {
    it("refuses more files than the limit", () => {
      const files = fileList(ANALYSIS_LIMITS.maxFiles + 1);
      expect(
        accepts(changed(...emptied, [["files"], files], [["limits", "filesListed"], files.length])),
      ).toBe(false);
    });

    it("accepts exactly the limit of files", () => {
      const files = fileList(ANALYSIS_LIMITS.maxFiles);
      expect(
        accepts(changed(...emptied, [["files"], files], [["limits", "filesListed"], files.length])),
      ).toBe(true);
    });

    it("refuses a variable with no file, and one with too many", () => {
      expect(accepts(changed([["envVars", 0, "files"], []]))).toBe(false);
      const many = Array.from({ length: ANALYSIS_LIMITS.maxEnvVarFiles + 1 }, () => "src/a.ts");
      expect(accepts(changed([["envVars", 0, "files"], many]))).toBe(false);
    });

    describe("dependencies, over all the packages together", () => {
      /** `total` dependencies, in packages of a thousand, each well within the limit of one package. */
      function packagesWith(total: number): unknown[] {
        const perPackage = 1_000;
        expect(perPackage).toBeLessThan(ANALYSIS_LIMITS.maxDependenciesPerPackage);
        return Array.from({ length: Math.ceil(total / perPackage) }, (_, index) => ({
          directory: `p${String(index)}`,
          dependencies: Array.from(
            { length: Math.min(perPackage, total - index * perPackage) },
            (_, number) => ({
              name: `d${String(index)}-${String(number)}`,
              kind: "runtime",
              source: "registry",
            }),
          ),
          scripts: [],
        }));
      }

      it("accepts exactly the limit", () => {
        const packages = packagesWith(ANALYSIS_LIMITS.maxDependencies);
        expect(accepts(changed([["packages"], packages]))).toBe(true);
      });

      it("refuses one more than the limit, though every package is within its own, and says where", () => {
        const packages = packagesWith(ANALYSIS_LIMITS.maxDependencies + 1);
        const result = repositoryFactsSchema.safeParse(changed([["packages"], packages]));
        expect(result.success).toBe(false);
        expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["packages"]);
      });

      it("is refused by parseRepositoryFacts as a fault of the packages and of nothing else", () => {
        const packages = packagesWith(ANALYSIS_LIMITS.maxDependencies + 1);
        const text = JSON.stringify(changed([["packages"], packages]));
        try {
          parseRepositoryFacts(text);
          expect.unreachable("it should have been refused");
        } catch (error) {
          expect(error).toBeInstanceOf(FactsRejected);
          expect((error as FactsRejected).paths).toEqual(["packages"]);
        }
      });
    });
  });
});

describe("parseRepositoryFacts", () => {
  /** What `parseRepositoryFacts` throws for the text, which is always a `FactsRejected`. */
  function rejection(text: string): FactsRejected {
    try {
      parseRepositoryFacts(text);
    } catch (error) {
      if (error instanceof FactsRejected) return error;
      throw error;
    }
    throw new Error("the text was accepted");
  }

  it("gives the facts of text that is valid", () => {
    expect(parseRepositoryFacts(JSON.stringify(valid()))).toEqual(valid());
  });

  it("refuses text that is not JSON, and says nothing of the text", () => {
    for (const text of ["", "{", "not json", "SECRET-TEXT-IN-OUTPUT"]) {
      const error = rejection(text);
      expect(error.paths).toEqual(["(not JSON)"]);
      expect(error.message).not.toContain("SECRET");
    }
  });

  it("names where the document is wrong, and never what it says", () => {
    const document = changed(
      [["files", 0, "path"], "../SECRET-PATH-VALUE"],
      [["envVars", 0, "name"], "SECRET NAME VALUE"],
    );
    const error = rejection(JSON.stringify(document));
    expect(error.paths).toEqual(expect.arrayContaining(["files.0.path", "envVars.0.name"]));
    expect(error.message).not.toContain("SECRET");
    expect(JSON.stringify(error.paths)).not.toContain("SECRET");
  });

  it("names the root when the document is not an object", () => {
    expect(rejection("[]").paths).toEqual(["(root)"]);
  });

  it("names no more than four levels of where it is wrong", () => {
    const document = changed([["packages", 0, "dependencies", 0, "range"], "a;b"]);
    expect(rejection(JSON.stringify(document)).paths).toEqual(["packages.0.dependencies.0"]);
  });

  it("names no more than twenty places", () => {
    const files = Array.from({ length: 50 }, () => ({ path: "../x" }));
    const error = rejection(JSON.stringify(changed([["files"], files])));
    expect(error.paths.length).toBeLessThanOrEqual(20);
  });

  it("refuses a document of a depth or of a size that is not a repository's, in the way it refuses any other", () => {
    expect(rejection("[".repeat(100_000)).paths).toEqual(["(not JSON)"]);
    expect(rejection(`{"a":${"1".repeat(1_000_000)}}`).paths.length).toBeGreaterThan(0);
  });
});
