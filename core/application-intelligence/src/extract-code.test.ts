import { describe, expect, it } from "vitest";
import { resolveLimits } from "./limits.js";
import { extractCode } from "./extract-code.js";

const limits = resolveLimits();

function read(text: string, path = "src/a.ts"): NonNullable<ReturnType<typeof extractCode>> {
  const facts = extractCode(path, text, limits);
  if (facts === null) throw new Error("the parser failed");
  return facts;
}

const specifiers = (text: string, path?: string): string[] =>
  read(text, path).imports.map((entry) => `${entry.kind}:${entry.specifier}`);

describe("imports", () => {
  it("reads every way of importing", () => {
    const text = [
      'import a from "static-default";',
      'import { b } from "static-named";',
      'import * as c from "static-star";',
      'import "side-effect";',
      'import type { D } from "type-only";',
      'import { type E } from "inline-type";',
      'export { f } from "export-named";',
      'export * from "export-star";',
      'export type { G } from "export-type";',
      'const h = await import("dynamic");',
      'const i = require("required");',
      'import j = require("import-equals");',
      'type K = import("import-type").L;',
    ].join("\n");
    expect(specifiers(text)).toEqual(
      expect.arrayContaining([
        "static:static-default",
        "static:static-named",
        "static:static-star",
        "static:side-effect",
        "type:type-only",
        "static:inline-type",
        "export-from:export-named",
        "export-from:export-star",
        "type:export-type",
        "dynamic:dynamic",
        "require:required",
        "require:import-equals",
        "type:import-type",
      ]),
    );
    expect(read(text).imports).toHaveLength(13);
  });

  it("gives the line of each import, counted from one", () => {
    const facts = read('\n\nimport a from "x";\n\n  const b = require("y");\n');
    expect(facts.imports.map((entry) => entry.line)).toEqual([3, 5]);
  });

  it("does not read what it cannot know from the text", () => {
    const text = [
      "const name = 'x';",
      "import(name);",
      "require(name);",
      "require(`a${name}`);",
      'require("a", "b");',
      "require();",
      "import();",
      "obj.require('not-a-require');",
    ].join("\n");
    expect(read(text).imports).toEqual([]);
  });

  it("reads a template without a substitution as the string that it is", () => {
    expect(specifiers("const a = require(`plain`);")).toEqual(["require:plain"]);
  });

  it("reads JavaScript and JSX as well as TypeScript", () => {
    expect(specifiers('const a = require("x"); module.exports = a;', "lib/a.cjs")).toEqual([
      "require:x",
    ]);
    expect(specifiers('import x from "y"; export const z = <x.A />;', "src/a.jsx")).toEqual([
      "static:y",
    ]);
    expect(specifiers('import x from "y"; export const z = <x.A />;', "src/a.tsx")).toEqual([
      "static:y",
    ]);
  });

  it("reads what is inside JSX, in a file of JavaScript or of TypeScript that has it", () => {
    const text =
      'import a from "a";\nconst el = <A b={process.env.X}>{require("r")}</A>;\nimport c from "c";\n';
    for (const path of ["src/a.jsx", "src/a.tsx", "src/a.js"]) {
      const facts = read(text, path);
      expect(
        facts.imports.map((entry) => entry.specifier),
        path,
      ).toEqual(["a", "r", "c"]);
      expect(
        facts.envVars.map((entry) => entry.name),
        path,
      ).toEqual(["X"]);
    }
  });

  it("collects the modules a file uses, by package", () => {
    const facts = read(
      [
        'import a from "@scope/pkg/deep/path";',
        'import b from "plain/deep";',
        'import c from "./local";',
        'import d from "node:http";',
        'import e from "http";',
      ].join("\n"),
    );
    expect([...facts.modules].sort()).toEqual(["@scope/pkg", "http", "node:http", "plain"].sort());
  });
});

describe("environment variables", () => {
  it("reads the name of a variable and never a value", () => {
    const facts = read(
      [
        "const a = process.env.DATABASE_URL;",
        'const b = process.env["API_KEY"];',
        "const c = process.env[`TEMPLATE_NAME`];",
        "const d = import.meta.env.VITE_THING;",
        'const e = import.meta.env["VITE_OTHER"];',
      ].join("\n"),
    );
    expect(facts.envVars.map((entry) => entry.name)).toEqual([
      "DATABASE_URL",
      "API_KEY",
      "TEMPLATE_NAME",
      "VITE_THING",
      "VITE_OTHER",
    ]);
    expect(facts.envVars.map((entry) => entry.line)).toEqual([1, 2, 3, 4, 5]);
    expect(JSON.stringify(facts.envVars)).not.toContain("secret-value");
  });

  it("reads the names in a destructuring, with a rename, a default, and a quoted key", () => {
    const facts = read(
      [
        "const { A, B: renamed, C = 'default-value', 'D': quoted, ...rest } = process.env;",
        "const { E } = import.meta.env;",
      ].join("\n"),
    );
    expect(facts.envVars.map((entry) => entry.name)).toEqual(["A", "B", "C", "D", "E"]);
    expect(JSON.stringify(facts)).not.toContain("default-value");
  });

  it("does not read a name that it cannot know, or one that is not a variable name", () => {
    const facts = read(
      [
        "const a = process.env[computed];",
        "const b = process.env;",
        'const c = process.env["not a name"];',
        'const d = process.env["1STARTS_WITH_DIGIT"];',
        "const e = env.NOT_PROCESS;",
        "const f = other.env.NOT_PROCESS;",
        "const { g } = notEnvironment;",
        `const h = process.env["${"X".repeat(129)}"];`,
      ].join("\n"),
    );
    expect(facts.envVars).toEqual([]);
  });

  it("counts every read, which the analysis adds up", () => {
    const facts = read("process.env.A; process.env.A; process.env.B;");
    expect(facts.envVars.map((entry) => entry.name)).toEqual(["A", "A", "B"]);
  });
});

describe("routes of a framework", () => {
  const express = 'import express from "express";\nconst app = express();\n';

  it("reads a call that is a route when the file imports a framework of routes", () => {
    const facts = read(
      `${express}app.get("/health", h);\napp.post("/orders", h);\nrouter.delete("/orders/:id", h);\napp.all("/any", h);`,
    );
    expect(facts.routes).toEqual([
      { method: "GET", path: "/health", line: 3, style: "router", confidence: "high" },
      { method: "POST", path: "/orders", line: 4, style: "router", confidence: "high" },
      { method: "DELETE", path: "/orders/:id", line: 5, style: "router", confidence: "high" },
      { method: "ALL", path: "/any", line: 6, style: "router", confidence: "high" },
    ]);
  });

  it.each([
    "express",
    "fastify",
    "hono",
    "koa-router",
    "@koa/router",
    "polka",
    "restify",
    "itty-router",
  ])("knows %s", (name) => {
    const facts = read(`import x from "${name}";\nx.get("/r", h);`);
    expect(facts.routes).toHaveLength(1);
  });

  it("does not take a lookup for a route in a file that imports no framework", () => {
    const facts = read('const value = map.get("/not-a-route");\ncache.get("/x");');
    expect(facts.routes).toEqual([]);
  });

  it("does not take a call for a route when the first argument is not a path", () => {
    const facts = read(
      `${express}app.get("settings");\napp.get(name, h);\napp.get();\napp.get(42);`,
    );
    expect(facts.routes).toEqual([]);
  });

  it("does not take a method that is not one of a router", () => {
    expect(read(`${express}app.listen("/x");\napp.use("/y", h);`).routes).toEqual([]);
  });

  it("leaves out a route whose path the facts cannot carry", () => {
    const facts = read(
      `${express}app.get("/with space", h);\napp.get("/${"a".repeat(300)}", h);\napp.get("/fine", h);`,
    );
    expect(facts.routes.map((route) => route.path)).toEqual(["/fine"]);
  });
});

describe("routes of a server of the standard library", () => {
  const http = 'import { createServer } from "node:http";\n';

  it("reads a method and a path that are compared together, and calls it a heuristic", () => {
    const facts = read(
      `${http}createServer((req, res) => {\n  if (req.method === "GET" && url.pathname === "/products") ok();\n});`,
    );
    expect(facts.routes).toEqual([
      { method: "GET", path: "/products", line: 3, style: "http", confidence: "heuristic" },
    ]);
  });

  it("reads the comparison with the operands in either order, and the other property names", () => {
    const facts = read(
      [
        http,
        'if ("POST" === req.method && "/a" == req.url) a();',
        'if (method === "PUT" && path === "/b") b();',
        'if (request.method == "DELETE" && request.originalUrl === "/c") c();',
        'if (pathname === "/d" && method === "PATCH") d();',
      ].join("\n"),
    );
    expect(facts.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /a",
      "PUT /b",
      "DELETE /c",
      "PATCH /d",
    ]);
  });

  it("reads a chain of conditions that has the two among others, once", () => {
    const facts = read(
      `${http}if (ready && req.method === "GET" && authorised && url.pathname === "/x" && more) go();`,
    );
    expect(facts.routes).toHaveLength(1);
    expect(facts.routes[0]).toMatchObject({ method: "GET", path: "/x" });
  });

  it("reads a chain that is wrapped in brackets, once", () => {
    const facts = read(`${http}if (((req.method === "GET") && (url.pathname === "/x"))) go();`);
    expect(facts.routes).toHaveLength(1);
  });

  it("does not take one condition, or a method with no path, for a route", () => {
    const facts = read(
      [
        http,
        'if (req.method === "GET") a();',
        'if (url.pathname === "/x") b();',
        'if (req.method === "GET" && ready) c();',
        'if (req.method === "GET" || url.pathname === "/y") d();',
        'if (req.method !== "GET" && url.pathname !== "/z") e();',
      ].join("\n"),
    );
    expect(facts.routes).toEqual([]);
  });

  it("does not take a comparison of something that is not a method or a path", () => {
    const facts = read(
      `${http}if (thing.kind === "GET" && thing.title === "/x") a();\nif (req.method === "get" && url.pathname === "x") b();`,
    );
    expect(facts.routes).toEqual([]);
  });

  it("does not take a comparison for the method when it is not of a method, or for the path when it is not of a path", () => {
    const facts = read(
      [
        http,
        'if (thing.kind === "GET" && url.pathname === "/a") a();',
        'if (req.method === "GET" && thing.title === "/b") b();',
        'if (thing.kind === "GET" || url.pathname === "/c") c();',
      ].join("\n"),
    );
    expect(facts.routes).toEqual([]);
  });

  it("is not looked for in a file that imports no server", () => {
    const facts = read('if (req.method === "GET" && url.pathname === "/x") a();');
    expect(facts.routes).toEqual([]);
  });
});

describe("a file the parser cannot handle well", () => {
  it("reads what it can from a file with a syntax error, and does not throw", () => {
    const facts = read('import a from "x";\nconst = ;;; {{{\nimport b from "y";\n');
    expect(facts.imports.map((entry) => entry.specifier)).toEqual(expect.arrayContaining(["x"]));
  });

  it("walks a tree that is deeper than the stack is", () => {
    const depth = 100_000;
    const facts = extractCode("src/deep.ts", `${"(".repeat(depth)}1${")".repeat(depth)}`, limits);
    // Whether the parser gives up (null) or reads it, it does not crash the analysis.
    expect(facts === null || facts.imports.length === 0).toBe(true);
  });

  it("walks a long chain of calls without recursion of its own", () => {
    const facts = read(`${"a".repeat(1)}${".b()".repeat(20_000)};\nimport x from "found";`);
    expect(facts.imports.map((entry) => entry.specifier)).toEqual(["found"]);
  });

  it("reads an empty file", () => {
    const facts = read("");
    expect(facts.imports).toEqual([]);
    expect(facts.envVars).toEqual([]);
    expect(facts.routes).toEqual([]);
  });

  it("does not run the code that it reads", () => {
    const marker = "__codemugs_extract_code_test_ran__";
    read(`globalThis.${marker} = true; process.exit(3); require("x");`);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });
});
