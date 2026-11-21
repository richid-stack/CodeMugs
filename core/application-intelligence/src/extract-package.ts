import type { AnalysisLimits } from "./limits.js";
import type { DependencyFact, PackageFact } from "./facts.js";

const PACKAGE_NAME = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const SEMVER_RANGE = /^[0-9A-Za-z.*^~<>=|+ -]{1,100}$/;
const SCRIPT_NAME = /^[A-Za-z0-9:_.-]{1,64}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

const DEPENDENCY_FIELDS: readonly (readonly [string, DependencyFact["kind"]])[] = [
  ["dependencies", "runtime"],
  ["devDependencies", "dev"],
  ["peerDependencies", "peer"],
  ["optionalDependencies", "optional"],
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Where a dependency comes from, and the range only when it is a registry one. A git or URL
 * dependency can carry a token in its text (`https://user:token@host/...`), a file or a link points
 * outside the repository, and none of that is a fact the analysis needs: the kind is.
 */
export function classifyDependency(spec: string): Pick<DependencyFact, "source" | "range"> {
  if (spec.startsWith("workspace:")) return { source: "workspace" };
  if (spec.startsWith("npm:")) return { source: "alias" };
  if (spec.startsWith("file:") || spec.startsWith("link:") || spec.startsWith("portal:")) {
    return { source: "file" };
  }
  if (/^(git|git\+[a-z]+|github|gitlab|bitbucket|gist):/i.test(spec) || spec.startsWith("git@")) {
    return { source: "git" };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) return { source: "url" };
  // `owner/repo` and `owner/repo#ref` are GitHub shorthand.
  if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec)) return { source: "git" };
  return SEMVER_RANGE.test(spec) ? { source: "registry", range: spec } : { source: "registry" };
}

export interface ExtractedPackage {
  readonly fact: PackageFact;
  /**
   * True when a dependency that the package declares, and that is of the kind the facts can carry,
   * was left out because of a limit (the limit of one package, or the room that was given). One that
   * is left out for being of another kind is not a cut.
   */
  readonly cut: boolean;
}

/**
 * Reads the text of a package.json. `null` when it is not JSON or not an object. Anything in it
 * that is not of the expected kind is left out and not guessed at.
 *
 * It keeps no more dependencies than a package may have, and no more than `room`, which is what
 * is left of the limit over all the packages (the caller counts; this does not know of the
 * others). Whether it left any out is in `cut`, so that it is never silent.
 */
export function extractPackage(
  directory: string,
  text: string,
  limits: AnalysisLimits,
  room: number = limits.maxDependencies,
): ExtractedPackage | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;

  // A limit may be given as a fraction (`resolveLimits` takes any number that is not negative), and
  // what is left of one is then a fraction too: 0.5 of room is no room for a dependency.
  const ceiling = Math.floor(Math.min(limits.maxDependenciesPerPackage, room));
  const dependencies: DependencyFact[] = [];
  let cut = false;
  for (const [field, kind] of DEPENDENCY_FIELDS) {
    const entries = json[field];
    if (!isRecord(entries)) continue;
    for (const name of Object.keys(entries).sort()) {
      const spec = entries[name];
      if (
        typeof spec !== "string" ||
        !PACKAGE_NAME.test(name) ||
        name.length > limits.maxNameLength
      ) {
        continue;
      }
      if (dependencies.length >= ceiling) {
        cut = true;
        break;
      }
      dependencies.push({ name, kind, ...classifyDependency(spec) });
    }
  }

  const scripts = isRecord(json["scripts"])
    ? Object.keys(json["scripts"])
        .filter((name) => SCRIPT_NAME.test(name))
        .sort()
        .slice(0, limits.maxScriptsPerPackage)
    : [];

  const name = json["name"];
  const version = json["version"];
  const moduleType = json["type"];
  return {
    fact: {
      directory,
      ...(typeof name === "string" && PACKAGE_NAME.test(name) && name.length <= limits.maxNameLength
        ? { name }
        : {}),
      ...(typeof version === "string" && VERSION.test(version) ? { version } : {}),
      ...(typeof json["private"] === "boolean" ? { private: json["private"] } : {}),
      ...(moduleType === "module" || moduleType === "commonjs" ? { moduleType } : {}),
      dependencies,
      scripts,
    },
    cut,
  };
}
