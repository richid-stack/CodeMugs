import type { Language, Role } from "./facts.js";

const BY_EXTENSION: Readonly<Record<string, Language>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  sh: "shell",
  bash: "shell",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
};

/** The extensions that the analyser parses: the syntax of TypeScript and of JavaScript. */
export const PARSED_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
]);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function languageOf(path: string): Language {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "Dockerfile" || name.startsWith("Dockerfile.")) return "dockerfile";
  return BY_EXTENSION[extensionOf(path)] ?? "other";
}

export function isParsed(path: string): boolean {
  return PARSED_EXTENSIONS.has(extensionOf(path));
}

const CODE_LANGUAGES: ReadonlySet<Language> = new Set([
  "typescript",
  "javascript",
  "sql",
  "python",
  "go",
  "rust",
  "java",
  "kotlin",
  "ruby",
  "php",
  "csharp",
  "c",
  "cpp",
  "shell",
  "html",
  "css",
]);

/** What a file is for, from its name alone. A guess, and a stable one. */
export function roleOf(path: string, language: Language): Role {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const parts = path.split("/");
  const inTestDirectory = parts
    .slice(0, -1)
    .some((part) => part === "__tests__" || part === "tests" || part === "test" || part === "e2e");
  if (
    /\.(test|spec)\.[a-z0-9]+$/i.test(name) ||
    (inTestDirectory && CODE_LANGUAGES.has(language))
  ) {
    return "test";
  }
  if (language === "markdown") return "docs";
  if (
    name === "package.json" ||
    /^tsconfig([.-].*)?\.json$/.test(name) ||
    /\.config\.[a-z0-9]+$/i.test(name) ||
    language === "dockerfile" ||
    language === "yaml" ||
    language === "toml" ||
    name.startsWith(".")
  ) {
    return "config";
  }
  if (CODE_LANGUAGES.has(language)) return "source";
  if (language === "json") return "data";
  return "other";
}
