import { z } from "zod";
import {
  ANALYSER_NAME,
  ANALYSIS_LIMITS,
  FACTS_VERSION,
  HTTP_METHODS,
  LANGUAGES,
  ROLES,
  TRUNCATION_REASONS,
} from "./constants.js";
import { hasControlCharacter } from "./text.js";

/**
 * What the analyser says about a repository, and what the host accepts of it.
 *
 * The analyser runs in the sandbox, over untrusted code, and it is itself a parser of untrusted
 * input, so what it prints is untrusted too: a flaw in a parser can make it print anything. The
 * host therefore checks the whole answer against this schema before it keeps a word of it. The
 * schema is strict (an unknown key is refused), every list and every string has a bound, the
 * characters of every name are limited, and the references inside the answer (an import from a file,
 * a route in a file) have to point at files that the answer lists.
 *
 * **Nothing in it is a secret or a file's content.** It has paths, names, line numbers, counts, and
 * the literal text of three kinds of thing that are a part of an interface and not of a
 * configuration: the specifier of an import, the path of a route, and the name of an environment
 * variable. An environment variable's value is never read, and a dependency that is a git or a URL
 * reference (where a token can be) is recorded as the kind and not as the text.
 *
 * The text in it still comes from the repository, so it is **data and never instructions**
 * (invariant 2), whatever it says.
 */

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const lineNumber = z.number().int().min(1).max(10_000_000);

/** A path in the repository: relative, with no `.` or `..` part, and no control character in it. */
export const repositoryPath = z
  .string()
  .min(1)
  .max(ANALYSIS_LIMITS.maxPathLength)
  .refine(
    (path) =>
      !hasControlCharacter(path) &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.split("/").some((part) => part === "" || part === "." || part === ".."),
    { message: "not a relative path inside the repository" },
  );

const specifier = z
  .string()
  .min(1)
  .max(ANALYSIS_LIMITS.maxSpecifierLength)
  .refine((text) => !hasControlCharacter(text), { message: "control character" });

const packageName = z
  .string()
  .min(1)
  .max(ANALYSIS_LIMITS.maxNameLength)
  .regex(/^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/);

const environmentVariableName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);

export const fileFact = z.strictObject({
  path: repositoryPath,
  language: z.enum(LANGUAGES),
  role: z.enum(ROLES),
  bytes: count,
  /** Lines of a text file that was read. Zero for a file that was not read, or is not text. */
  lines: count,
});

const dependencyKinds = ["runtime", "dev", "peer", "optional"] as const;
const dependencySources = ["registry", "workspace", "file", "git", "url", "alias"] as const;

export const dependencyFact = z.strictObject({
  name: packageName,
  kind: z.enum(dependencyKinds),
  /** Where it comes from. A git or URL source can hold a token, so only the kind is kept. */
  source: z.enum(dependencySources),
  /** The version range, and only for a registry dependency and only when it is written as one. */
  range: z
    .string()
    .regex(/^[0-9A-Za-z.*^~<>=|+ -]{1,100}$/)
    .optional(),
});

export const packageFact = z.strictObject({
  /** The directory of the package.json, or "." for the root of the repository. */
  directory: z.union([z.literal("."), repositoryPath]),
  name: packageName.optional(),
  version: z
    .string()
    .regex(/^[0-9A-Za-z.+-]{1,64}$/)
    .optional(),
  private: z.boolean().optional(),
  moduleType: z.enum(["module", "commonjs"]).optional(),
  dependencies: z.array(dependencyFact).max(ANALYSIS_LIMITS.maxDependenciesPerPackage),
  /** The names of the scripts. What they run is not kept: a command can hold a secret. */
  scripts: z
    .array(z.string().regex(/^[A-Za-z0-9:_.-]{1,64}$/))
    .max(ANALYSIS_LIMITS.maxScriptsPerPackage),
});

const importKinds = ["static", "type", "dynamic", "require", "export-from"] as const;

export const importFact = z.strictObject({
  from: repositoryPath,
  specifier,
  kind: z.enum(importKinds),
  /** Where it points. `internal` is a file of the repository, which the answer lists. */
  target: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("internal"), path: repositoryPath }),
    z.strictObject({ type: z.literal("package"), name: packageName }),
    z.strictObject({ type: z.literal("builtin"), name: z.string().regex(/^[a-z0-9_/]{1,64}$/) }),
    z.strictObject({ type: z.literal("unresolved") }),
  ]),
  /** The line of the first time the file does it. */
  line: lineNumber,
});

export const envVarFact = z.strictObject({
  name: environmentVariableName,
  /** How many times the repository reads it. Its value is never read. */
  reads: count,
  files: z.array(repositoryPath).min(1).max(ANALYSIS_LIMITS.maxEnvVarFiles),
});

export const routeFact = z.strictObject({
  method: z.enum(HTTP_METHODS),
  path: z
    .string()
    .min(1)
    .max(ANALYSIS_LIMITS.maxRoutePathLength)
    .regex(/^\/[\x21-\x7e]*$/),
  file: repositoryPath,
  line: lineNumber,
  /** `router` for a call such as `app.get("/x", handler)` of a framework that the file imports,
   * and `http` for a request that is compared with a method and a path. */
  style: z.enum(["router", "http"]),
  /** How sure it is: `router` calls are `high`, and a comparison is a `heuristic`. */
  confidence: z.enum(["high", "heuristic"]),
});

export const frameworkFact = z.strictObject({
  name: z.string().regex(/^[a-z0-9@/._:-]{1,100}$/),
  category: z.enum(["web", "test", "orm", "ui", "build", "runtime"]),
  /** `dependency` is declared in a package.json, and `import` is imported by a file. */
  evidence: z.enum(["dependency", "import"]),
  /** How many files show it, and the first few of them. */
  usedIn: count,
  files: z.array(repositoryPath).min(1).max(ANALYSIS_LIMITS.maxFrameworkFiles),
});

const skipped = z.strictObject({
  symlink: count,
  tooLarge: count,
  unreadable: count,
  ignoredDirectory: count,
  badName: count,
  parseFailed: count,
  invalidSpecifier: count,
});

const factsObject = z.strictObject({
  version: z.literal(FACTS_VERSION),
  analyser: z.strictObject({ name: z.literal(ANALYSER_NAME), typescript: z.string().max(32) }),
  limits: z.strictObject({
    filesSeen: count,
    filesListed: count,
    filesParsed: count,
    bytesRead: count,
    /** What was cut short. Empty when nothing was. */
    truncated: z.array(z.enum(TRUNCATION_REASONS)).max(TRUNCATION_REASONS.length),
    skipped,
  }),
  files: z.array(fileFact).max(ANALYSIS_LIMITS.maxFiles),
  packages: z.array(packageFact).max(ANALYSIS_LIMITS.maxPackages),
  imports: z.array(importFact).max(ANALYSIS_LIMITS.maxImports),
  envVars: z.array(envVarFact).max(ANALYSIS_LIMITS.maxEnvVars),
  routes: z.array(routeFact).max(ANALYSIS_LIMITS.maxRoutes),
  frameworks: z.array(frameworkFact).max(ANALYSIS_LIMITS.maxFrameworks),
});

/**
 * The answer is only right if it agrees with itself: a reference must point at a file that it
 * lists, and a path is listed once. A schema of one object at a time cannot say that.
 */
export const repositoryFactsSchema = factsObject.superRefine((facts, context) => {
  const paths = new Set<string>();
  for (const [index, file] of facts.files.entries()) {
    if (paths.has(file.path)) {
      context.addIssue({ code: "custom", path: ["files", index, "path"], message: "listed twice" });
    }
    paths.add(file.path);
  }
  const unlisted = (path: string): boolean => !paths.has(path);
  for (const [index, entry] of facts.imports.entries()) {
    if (unlisted(entry.from)) {
      context.addIssue({ code: "custom", path: ["imports", index, "from"], message: "not listed" });
    }
    if (entry.target.type === "internal" && unlisted(entry.target.path)) {
      context.addIssue({
        code: "custom",
        path: ["imports", index, "target"],
        message: "not listed",
      });
    }
  }
  for (const [index, route] of facts.routes.entries()) {
    if (unlisted(route.file)) {
      context.addIssue({ code: "custom", path: ["routes", index, "file"], message: "not listed" });
    }
  }
  for (const [index, variable] of facts.envVars.entries()) {
    if (variable.files.some(unlisted)) {
      context.addIssue({
        code: "custom",
        path: ["envVars", index, "files"],
        message: "not listed",
      });
    }
  }
  for (const [index, framework] of facts.frameworks.entries()) {
    if (framework.files.some(unlisted)) {
      context.addIssue({
        code: "custom",
        path: ["frameworks", index, "files"],
        message: "not listed",
      });
    }
  }
  // The limit of one package and the limit of packages allow two million dependencies together,
  // twenty times what a graph is measured for, so the total is bounded as well.
  let dependencies = 0;
  for (const entry of facts.packages) dependencies += entry.dependencies.length;
  if (dependencies > ANALYSIS_LIMITS.maxDependencies) {
    context.addIssue({
      code: "custom",
      path: ["packages"],
      message: "more dependencies than the limit allows",
    });
  }
  if (facts.limits.filesListed !== facts.files.length) {
    context.addIssue({
      code: "custom",
      path: ["limits", "filesListed"],
      message: "does not match the files listed",
    });
  }
});

export type RepositoryFacts = z.infer<typeof factsObject>;
export type FileFact = z.infer<typeof fileFact>;
export type PackageFact = z.infer<typeof packageFact>;
export type DependencyFact = z.infer<typeof dependencyFact>;
export type ImportFact = z.infer<typeof importFact>;
export type EnvVarFact = z.infer<typeof envVarFact>;
export type RouteFact = z.infer<typeof routeFact>;
export type FrameworkFact = z.infer<typeof frameworkFact>;
export type Language = (typeof LANGUAGES)[number];
export type Role = (typeof ROLES)[number];

/** Why the answer was refused: where it is wrong, and never what it says. */
export class FactsRejected extends Error {
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    super(`the analysis does not match the schema at: ${paths.join(", ")}`);
    this.name = "FactsRejected";
    this.paths = paths;
  }
}

/** Checks text that came out of the sandbox, and returns the facts or throws `FactsRejected`. */
export function parseRepositoryFacts(text: string): RepositoryFacts {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new FactsRejected(["(not JSON)"]);
  }
  const result = repositoryFactsSchema.safeParse(json);
  if (!result.success) {
    const where = [
      ...new Set(
        result.error.issues
          .slice(0, 20)
          .map((issue) => issue.path.slice(0, 4).join(".") || "(root)"),
      ),
    ];
    throw new FactsRejected(where);
  }
  return result.data;
}
