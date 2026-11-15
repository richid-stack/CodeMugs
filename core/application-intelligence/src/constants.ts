/**
 * What the analyser is willing to do, and the most it will say. Everything is bounded, because the
 * repository is untrusted: a repository can be made to hold millions of files, a file of nothing
 * but parentheses, or a package.json with a million dependencies, and the analyser has to answer
 * (with `truncated` set, and never silently) in a time and a size that the caller can budget.
 *
 * This file has no imports, so that the analyser that runs in the sandbox does not load a schema
 * library to read it.
 */
export const FACTS_VERSION = 1;
export const ANALYSER_NAME = "codemugs-ts-analyser";

export const ANALYSIS_LIMITS = Object.freeze({
  /** Files listed in the facts. More than this are counted and not listed. */
  maxFiles: 20_000,
  /** A file bigger than this is listed and not read. */
  maxFileBytes: 1_048_576,
  /** Bytes read, over all files. */
  maxTotalBytes: 256 * 1_048_576,
  maxImports: 100_000,
  maxRoutes: 5_000,
  maxEnvVars: 2_000,
  /** Files named for one environment variable. */
  maxEnvVarFiles: 20,
  maxPackages: 1_000,
  maxDependenciesPerPackage: 2_000,
  maxScriptsPerPackage: 200,
  maxFrameworks: 200,
  /** Files named for one framework. */
  maxFrameworkFiles: 20,
  maxPathLength: 512,
  maxDirectoryDepth: 40,
  maxSpecifierLength: 300,
  maxRoutePathLength: 200,
  maxNameLength: 214,
  /** The time after which the analyser stops reading files, in milliseconds. */
  deadlineMs: 120_000,
});

/** Directories that are not looked into: what is built, what is installed, and our own staging. */
export const IGNORED_DIRECTORIES: readonly string[] = Object.freeze([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".codemugs",
]);

export const LANGUAGES = [
  "typescript",
  "javascript",
  "json",
  "markdown",
  "yaml",
  "toml",
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
  "dockerfile",
  "html",
  "css",
  "other",
] as const;

export const ROLES = ["source", "test", "config", "docs", "data", "other"] as const;

export const TRUNCATION_REASONS = [
  "files",
  "bytes",
  "imports",
  "routes",
  "env-vars",
  "packages",
  "frameworks",
  "time",
  "depth",
] as const;

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ALL",
] as const;
