import ts from "typescript";
import type { AnalysisLimits } from "./limits.js";
import type { ImportFact, RouteFact } from "./facts.js";

/**
 * What one file says, from its syntax alone. The code is parsed and never run, and never type
 * checked: nothing here follows an import to another file, evaluates an expression or reads the
 * environment. That is what keeps the analyser a parser of untrusted text and not an executor of
 * it (and the whole of it still runs inside the sandbox, because a parser has flaws, ADR 0007).
 */
export interface CodeFacts {
  readonly imports: readonly RawImport[];
  readonly envVars: readonly { name: string; line: number }[];
  readonly routes: readonly Omit<RouteFact, "file">[];
  /** The bare packages and built-in modules the file imports, for the frameworks it uses. */
  readonly modules: ReadonlySet<string>;
}

export interface RawImport {
  readonly specifier: string;
  readonly kind: ImportFact["kind"];
  readonly line: number;
}

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ROUTER_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const PATH_PROPERTIES = new Set(["pathname", "path", "url", "originalUrl"]);
/** Packages whose import makes `x.get("/path", ...)` a route and not a lookup of something else. */
export const ROUTER_PACKAGES: ReadonlySet<string> = new Set([
  "express",
  "fastify",
  "hono",
  "koa-router",
  "@koa/router",
  "polka",
  "restify",
  "itty-router",
]);
const HTTP_MODULES = new Set(["http", "https", "http2", "node:http", "node:https", "node:http2"]);

function scriptKindOf(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function textOf(node: ts.Node | undefined): string | undefined {
  return node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function isProcessEnv(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "env" &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process"
  );
}

function isImportMetaEnv(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "env" &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

const isEnvironment = (node: ts.Expression): boolean => isProcessEnv(node) || isImportMetaEnv(node);

/** The comparisons in a chain of `&&`, flattened. A chain is `((a && b) && c)`. */
function conjuncts(root: ts.BinaryExpression, covered: Set<ts.Node>): ts.Expression[] {
  const found: ts.Expression[] = [];
  const pending: ts.Expression[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    let inner: ts.Expression = node;
    while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
    if (
      ts.isBinaryExpression(inner) &&
      inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      covered.add(inner);
      pending.push(inner.right, inner.left);
    } else {
      found.push(inner);
    }
  }
  return found;
}

function comparedWith(
  expression: ts.Expression,
): { literal: string; other: ts.Expression } | undefined {
  if (!ts.isBinaryExpression(expression)) return undefined;
  const kind = expression.operatorToken.kind;
  if (kind !== ts.SyntaxKind.EqualsEqualsEqualsToken && kind !== ts.SyntaxKind.EqualsEqualsToken)
    return undefined;
  const left = textOf(expression.left);
  if (left !== undefined) return { literal: left, other: expression.right };
  const right = textOf(expression.right);
  return right === undefined ? undefined : { literal: right, other: expression.left };
}

const isMethodExpression = (node: ts.Expression): boolean =>
  (ts.isPropertyAccessExpression(node) && node.name.text === "method") ||
  (ts.isIdentifier(node) && node.text === "method");

const isPathExpression = (node: ts.Expression): boolean =>
  (ts.isPropertyAccessExpression(node) && PATH_PROPERTIES.has(node.name.text)) ||
  (ts.isIdentifier(node) && PATH_PROPERTIES.has(node.text));

/**
 * Reads one file. `null` when the parser failed on it (an error of its own, such as a stack that
 * a file of nested brackets used up), which the caller counts and does not report as a fact.
 */
export function extractCode(path: string, text: string, limits: AnalysisLimits): CodeFacts | null {
  try {
    return extract(path, text, limits);
  } catch {
    return null;
  }
}

function extract(path: string, text: string, limits: AnalysisLimits): CodeFacts {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKindOf(path));
  const lineOf = (node: ts.Node): number =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

  const imports: RawImport[] = [];
  const envVars: { name: string; line: number }[] = [];
  const routerCalls: { method: string; path: string; line: number }[] = [];
  const httpRoutes: { method: string; path: string; line: number }[] = [];
  const modules = new Set<string>();
  const covered = new Set<ts.Node>();

  const addImport = (
    specifier: string | undefined,
    kind: ImportFact["kind"],
    node: ts.Node,
  ): void => {
    if (specifier === undefined) return;
    imports.push({ specifier, kind, line: lineOf(node) });
  };
  const addEnvironment = (name: string | undefined, node: ts.Node): void => {
    if (name !== undefined && ENVIRONMENT_NAME.test(name))
      envVars.push({ name, line: lineOf(node) });
  };

  // The tree is walked with a list and not by recursion: a file of nested brackets makes a tree
  // that is deeper than the stack is.
  const pending: ts.Node[] = [file];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;

    if (ts.isImportDeclaration(node)) {
      const typeOnly = node.importClause?.isTypeOnly === true;
      addImport(textOf(node.moduleSpecifier), typeOnly ? "type" : "static", node);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      addImport(textOf(node.moduleSpecifier), node.isTypeOnly ? "type" : "export-from", node);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addImport(textOf(node.moduleReference.expression), "require", node);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addImport(textOf(node.argument.literal), "type", node);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const first = node.arguments[0];
      if (callee.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1) {
        addImport(textOf(first), "dynamic", node);
      } else if (
        ts.isIdentifier(callee) &&
        callee.text === "require" &&
        node.arguments.length === 1
      ) {
        addImport(textOf(first), "require", node);
      } else if (ts.isPropertyAccessExpression(callee) && ROUTER_METHODS.has(callee.name.text)) {
        const route = textOf(first);
        if (route !== undefined && route.startsWith("/")) {
          routerCalls.push({
            method: callee.name.text.toUpperCase(),
            path: route,
            line: lineOf(node),
          });
        }
      }
    } else if (ts.isPropertyAccessExpression(node) && isEnvironment(node.expression)) {
      addEnvironment(node.name.text, node);
    } else if (ts.isElementAccessExpression(node) && isEnvironment(node.expression)) {
      addEnvironment(textOf(node.argumentExpression), node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      isEnvironment(node.initializer)
    ) {
      for (const element of node.name.elements) {
        const named = element.propertyName ?? element.name;
        if (!element.dotDotDotToken && (ts.isIdentifier(named) || ts.isStringLiteral(named))) {
          addEnvironment(named.text, element);
        }
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      !covered.has(node)
    ) {
      let method: string | undefined;
      let route: string | undefined;
      for (const comparison of conjuncts(node, covered)) {
        const compared = comparedWith(comparison);
        if (compared === undefined) continue;
        if (HTTP_VERBS.has(compared.literal) && isMethodExpression(compared.other)) {
          method = compared.literal;
        } else if (compared.literal.startsWith("/") && isPathExpression(compared.other)) {
          route = compared.literal;
        }
      }
      if (method !== undefined && route !== undefined) {
        httpRoutes.push({ method, path: route, line: lineOf(node) });
      }
    }

    // Pushed in reverse, so that they come off the list in the order of the source.
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) pending.push(child);
    }
  }

  for (const entry of imports) {
    const name = entry.specifier;
    // A path (`./x`, `/x`) and a subpath import (`#x`) are the repository's own, not a package.
    if (name.startsWith(".") || name.startsWith("/") || name.startsWith("#")) continue;
    modules.add(
      name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : (name.split("/")[0] ?? name),
    );
    if (HTTP_MODULES.has(name)) modules.add(name);
  }

  const router = [...modules].some((name) => ROUTER_PACKAGES.has(name));
  const http = [...modules].some((name) => HTTP_MODULES.has(name));
  const routes: Omit<RouteFact, "file">[] = [];
  const valid = (route: string): boolean =>
    route.length <= limits.maxRoutePathLength && /^\/[\x21-\x7e]*$/.test(route);
  if (router) {
    for (const call of routerCalls) {
      if (valid(call.path)) {
        routes.push({
          method: call.method as RouteFact["method"],
          path: call.path,
          line: call.line,
          style: "router",
          confidence: "high",
        });
      }
    }
  }
  if (http) {
    for (const found of httpRoutes) {
      if (valid(found.path)) {
        routes.push({
          method: found.method as RouteFact["method"],
          path: found.path,
          line: found.line,
          style: "http",
          confidence: "heuristic",
        });
      }
    }
  }

  return { imports, envVars, routes, modules };
}
