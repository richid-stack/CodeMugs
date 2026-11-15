import { builtinModules } from "node:module";
import { posix } from "node:path";
import type { ImportFact } from "./facts.js";

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const INDEX_FILES = SOURCE_EXTENSIONS.map((extension) => `/index${extension}`);
/** `import "./a.js"` in a TypeScript file means `./a.ts`, so a written extension can name another. */
const SWAPPED: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/** The package a bare specifier names: `a/b/c` is `a`, and `@s/a/b` is `@s/a`. */
export function packageOfSpecifier(specifier: string): string | undefined {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return parts.length >= 2 && parts[0] !== "@" && parts[1] !== ""
      ? `${parts[0]}/${parts[1]}`
      : undefined;
  }
  return parts[0] === "" ? undefined : parts[0];
}

/**
 * Where an import points. A relative specifier is looked up among the files that were listed, the
 * way Node and TypeScript look for it (the extension as written, another extension for it, a
 * directory's index file). Nothing is read from disk, so a specifier cannot make the analyser look
 * at a file that is not in the list.
 */
export function resolveSpecifier(
  from: string,
  specifier: string,
  files: ReadonlySet<string>,
): ImportFact["target"] {
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier === "." ||
    specifier === ".."
  ) {
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    if (base === ".." || base.startsWith("../") || base.startsWith("/"))
      return { type: "unresolved" };
    const stem = base.replace(/\/+$/, "");
    const candidates = [stem];
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${stem}${extension}`);
    for (const [written, swaps] of Object.entries(SWAPPED)) {
      if (stem.endsWith(written)) {
        for (const swap of swaps) candidates.push(`${stem.slice(0, -written.length)}${swap}`);
      }
    }
    for (const index of INDEX_FILES)
      candidates.push(`${stem === "." ? "" : stem}${index}`.replace(/^\//, ""));
    for (const candidate of candidates) {
      if (candidate !== "" && files.has(candidate)) return { type: "internal", path: candidate };
    }
    return { type: "unresolved" };
  }
  if (specifier.startsWith("node:")) {
    const name = specifier.slice("node:".length);
    return /^[a-z0-9_/]{1,64}$/.test(name) ? { type: "builtin", name } : { type: "unresolved" };
  }
  const name = packageOfSpecifier(specifier);
  if (name === undefined || specifier.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
    return { type: "unresolved" };
  }
  if (BUILTINS.has(specifier)) {
    return /^[a-z0-9_/]{1,64}$/.test(specifier)
      ? { type: "builtin", name: specifier }
      : { type: "unresolved" };
  }
  return /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/.test(name) && name.length <= 214
    ? { type: "package", name }
    : { type: "unresolved" };
}
