import { performance } from "node:perf_hooks";
import ts from "typescript";
import { ANALYSER_NAME, FACTS_VERSION, type TRUNCATION_REASONS } from "./constants.js";
import { extractCode } from "./extract-code.js";
import { extractPackage } from "./extract-package.js";
import type {
  EnvVarFact,
  FileFact,
  FrameworkFact,
  ImportFact,
  PackageFact,
  RepositoryFacts,
  RouteFact,
} from "./facts.js";
import { KNOWN_FRAMEWORKS } from "./frameworks.js";
import { isParsed, languageOf, roleOf } from "./languages.js";
import { resolveLimits, type AnalysisLimits } from "./limits.js";
import { resolveSpecifier } from "./resolve.js";
import type { AnalysisSource } from "./source.js";
import { hasControlCharacter } from "./text.js";

export interface AnalyseOptions {
  /** Limits lower than the defaults, and never higher. `deadlineMs` is when no more files are read. */
  readonly limits?: Partial<AnalysisLimits>;
}

type Truncation = (typeof TRUNCATION_REASONS)[number];

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A file that is text, as far as a look at its start can tell: it has no NUL byte in the first 8 KiB. */
function looksLikeText(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8192).includes(0);
}

function countLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lines = 0;
  for (const byte of buffer) if (byte === 10) lines += 1;
  return buffer[buffer.length - 1] === 10 ? lines : lines + 1;
}

/**
 * Reads a repository and says what it holds. The same files give the same answer (every list is
 * sorted), what is cut short is said in `limits.truncated`, and nothing is run: the code is parsed
 * and not evaluated.
 *
 * **This runs over customer code, so it must only be called inside a sandbox** (invariant 8, ADR
 * 0007). The host never imports it: it is not exported from the package's main entry.
 */
export async function analyse(
  source: AnalysisSource,
  options: AnalyseOptions = {},
): Promise<RepositoryFacts> {
  const started = performance.now();
  const limits = resolveLimits(options.limits);
  const deadline = limits.deadlineMs;
  const truncated = new Set<Truncation>();

  const listing = await source.list(limits);
  const skips = listing.skips;
  if (listing.seen > listing.files.length) truncated.add("files");
  if (listing.depthExceeded) truncated.add("depth");
  const listed = new Set(listing.files.map((file) => file.path));

  const files: FileFact[] = [];
  const packages: PackageFact[] = [];
  const imports: ImportFact[] = [];
  const environment = new Map<string, { reads: number; files: Set<string> }>();
  const routes: RouteFact[] = [];
  const frameworks = new Map<
    string,
    {
      name: string;
      category: FrameworkFact["category"];
      evidence: FrameworkFact["evidence"];
      files: Set<string>;
    }
  >();
  let bytesRead = 0;
  let filesParsed = 0;

  const addFramework = (name: string, evidence: FrameworkFact["evidence"], file: string): void => {
    const category = KNOWN_FRAMEWORKS[name];
    if (category === undefined) return;
    const key = `${name}\n${evidence}`;
    let known = frameworks.get(key);
    if (known === undefined) {
      if (frameworks.size >= limits.maxFrameworks) {
        truncated.add("frameworks");
        return;
      }
      known = { name, category, evidence, files: new Set() };
      frameworks.set(key, known);
    }
    known.files.add(file);
  };

  for (const file of listing.files) {
    const language = languageOf(file.path);
    const role = roleOf(file.path, language);
    const wantsParse = isParsed(file.path);
    const isManifest = file.path === "package.json" || file.path.endsWith("/package.json");

    let lines = 0;
    let buffer: Buffer | null = null;
    const outOfTime = performance.now() - started >= deadline;
    if (outOfTime) truncated.add("time");

    if (file.bytes > limits.maxFileBytes) {
      skips.tooLarge += 1;
    } else if (!outOfTime && bytesRead + file.bytes <= limits.maxTotalBytes) {
      try {
        buffer = await file.read();
        bytesRead += buffer.length;
      } catch {
        skips.unreadable += 1;
      }
    } else if (!outOfTime) {
      truncated.add("bytes");
    }

    const isText = buffer !== null && looksLikeText(buffer);
    if (buffer !== null && isText) lines = countLines(buffer);
    files.push({ path: file.path, language, role, bytes: file.bytes, lines });

    if (buffer === null || !isText) continue;
    const text = buffer.toString("utf8");

    if (isManifest) {
      const directory =
        file.path === "package.json" ? "." : file.path.slice(0, -"/package.json".length);
      const fact = extractPackage(directory, text, limits);
      if (fact === null) {
        skips.parseFailed += 1;
      } else if (packages.length >= limits.maxPackages) {
        truncated.add("packages");
      } else {
        packages.push(fact);
        for (const dependency of fact.dependencies) {
          addFramework(dependency.name, "dependency", file.path);
        }
      }
    } else if (wantsParse) {
      const facts = extractCode(file.path, text, limits);
      if (facts === null) {
        skips.parseFailed += 1;
        continue;
      }
      filesParsed += 1;

      const seen = new Set<string>();
      for (const entry of facts.imports) {
        if (
          entry.specifier.length > limits.maxSpecifierLength ||
          hasControlCharacter(entry.specifier)
        ) {
          skips.invalidSpecifier += 1;
          continue;
        }
        const key = `${entry.kind}\n${entry.specifier}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (imports.length >= limits.maxImports) {
          truncated.add("imports");
          continue;
        }
        imports.push({
          from: file.path,
          specifier: entry.specifier,
          kind: entry.kind,
          target: resolveSpecifier(file.path, entry.specifier, listed),
          line: entry.line,
        });
      }
      for (const name of facts.modules) addFramework(name, "import", file.path);

      for (const variable of facts.envVars) {
        let known = environment.get(variable.name);
        if (known === undefined) {
          if (environment.size >= limits.maxEnvVars) {
            truncated.add("env-vars");
            continue;
          }
          known = { reads: 0, files: new Set() };
          environment.set(variable.name, known);
        }
        known.reads += 1;
        if (known.files.size < limits.maxEnvVarFiles) known.files.add(file.path);
      }

      for (const route of facts.routes) {
        if (routes.length >= limits.maxRoutes) {
          truncated.add("routes");
          break;
        }
        routes.push({ ...route, file: file.path });
      }
    }
  }

  const envVars: EnvVarFact[] = [...environment.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([name, value]) => ({ name, reads: value.reads, files: [...value.files].sort(compare) }));

  imports.sort(
    (a, b) =>
      compare(a.from, b.from) ||
      a.line - b.line ||
      compare(a.specifier, b.specifier) ||
      compare(a.kind, b.kind),
  );
  routes.sort(
    (a, b) =>
      compare(a.file, b.file) ||
      a.line - b.line ||
      compare(a.method, b.method) ||
      compare(a.path, b.path),
  );
  packages.sort((a, b) => compare(a.directory, b.directory));
  const frameworkList: FrameworkFact[] = [...frameworks.values()]
    .sort((a, b) => compare(a.name, b.name) || compare(a.evidence, b.evidence))
    .map((framework) => ({
      name: framework.name,
      category: framework.category,
      evidence: framework.evidence,
      usedIn: framework.files.size,
      files: [...framework.files].sort(compare).slice(0, limits.maxFrameworkFiles),
    }));

  return {
    version: FACTS_VERSION,
    analyser: { name: ANALYSER_NAME, typescript: ts.version },
    limits: {
      filesSeen: listing.seen,
      filesListed: files.length,
      filesParsed,
      bytesRead,
      truncated: [...truncated].sort(),
      skipped: skips,
    },
    files,
    packages,
    imports,
    envVars,
    routes,
    frameworks: frameworkList,
  };
}
