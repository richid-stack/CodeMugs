import { constants, type Dirent } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYSIS_LIMITS, IGNORED_DIRECTORIES } from "./constants.js";
import { AnalysisError } from "./errors.js";

/**
 * What goes into the directory that the sandbox shows to the analyser, read-only.
 *
 * The sandbox's policy has one place to show something from the host, so the analyser, the one
 * library that it needs and the repository are put side by side in it:
 *
 * ```
 * <directory>/tool/package.json                         {"type":"module"}
 * <directory>/tool/dist/*.js                            the analyser and what it imports
 * <directory>/tool/node_modules/typescript/...          the parser, and only the parser
 * <directory>/repo/...                                  a copy of the repository
 * ```
 *
 * The repository is **under `repo/`** and the tool is beside it, so no path in a repository can
 * name a file of the tool (a repository with a `tool/` directory of its own has it at `repo/tool/`).
 *
 * This is host code that reads a customer's files, and it only copies bytes: nothing in it runs, parses,
 * follows a link or opens a path that the repository names. What it keeps is bounded.
 */

/** The names inside the staging directory. The analysis's command is written from these. */
export const STAGED_TOOL_DIRECTORY = "tool";
export const STAGED_REPOSITORY_DIRECTORY = "repo";
export const STAGED_ENTRY = "tool/dist/main.js";

/**
 * What the host copies at most for one analysis. They are above the analyser's own limits (20,000
 * files, 256 MiB), so that the analyser is the one that says that a repository was cut short, and
 * they are there so that a repository cannot fill the host's disk or its time.
 */
export const STAGING_LIMITS = Object.freeze({
  /** Files, directories and links together. */
  maxEntries: 200_000,
  /** The bytes of content that are copied. A file that the analyser does not read is not copied. */
  maxContentBytes: 512 * 1_048_576,
  maxDepth: 100,
});

export type StagingLimits = { -readonly [Key in keyof typeof STAGING_LIMITS]: number };

export interface StageOptions {
  /** The checkout, as a plain absolute path. */
  readonly repository: string;
  /** The folder that the sandbox manager keeps its working copies in. */
  readonly workspaceRoot: string;
  /** Lower limits for a test. They cannot be higher than {@link STAGING_LIMITS}. */
  readonly limits?: Partial<StagingLimits>;
}

export interface Staged {
  /** The directory to show the sandbox. */
  readonly directory: string;
  /** Removes it. Safe to call more than once. */
  cleanup(): Promise<void>;
}

const DIRECTORY_MODE = 0o755;
const FILE_MODE = 0o644;

/**
 * Copies the analyser, the parser and the repository into a new directory under the workspace.
 *
 * It fails with an {@link AnalysisError} and with nothing else: a repository that cannot be read, or
 * that is too large, says so, and any other failure (a disk that is full, a workspace that cannot be
 * written) is `sandbox_failed`, without the text of the error that the system gave, which can name
 * paths. A directory that could not be removed afterwards is `cleanup_failed`, and is reported even
 * when something else went wrong first: it holds a copy of a customer's code and someone has to
 * remove it.
 */
export async function stageAnalysis(options: StageOptions): Promise<Staged> {
  const limits = resolveStagingLimits(options.limits);
  const repository = resolve(options.repository);
  let directory: string;
  try {
    directory = await mkdtemp(join(resolve(options.workspaceRoot), "analysis-"));
  } catch {
    throw new AnalysisError("sandbox_failed");
  }
  const cleanup = async (): Promise<void> => {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      throw new AnalysisError("cleanup_failed");
    }
  };
  try {
    // The run's user is drawn at random, owns nothing and reads the directory as "other".
    await chmod(directory, DIRECTORY_MODE);
    await stageTool(join(directory, STAGED_TOOL_DIRECTORY));
    await copyRepository(repository, join(directory, STAGED_REPOSITORY_DIRECTORY), limits);
  } catch (error) {
    await cleanup();
    throw error instanceof AnalysisError ? error : new AnalysisError("sandbox_failed");
  }
  return { directory, cleanup };
}

function resolveStagingLimits(overrides: Partial<StagingLimits> | undefined): StagingLimits {
  const limits: StagingLimits = { ...STAGING_LIMITS };
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (!(name in limits)) throw new RangeError("unknown limit");
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new RangeError("a limit must be a whole number that is not negative");
    }
    const key = name as keyof StagingLimits;
    limits[key] = Math.min(value, STAGING_LIMITS[key]);
  }
  return limits;
}

// ---------------------------------------------------------------------------------------------
// The tool

/**
 * The files of this package's build that the command needs: the ones that `main.js` imports, and the
 * ones that those import. It is read from the build and not written here, so that a file that the
 * analyser comes to import is staged without anyone remembering to add it, and so that the host-only
 * files (the schema, this file) are never staged. An import that is neither a file of the
 * package, a module of Node nor the parser is a mistake in the build, and stops here.
 */
export async function analyserFiles(distribution: string): Promise<string[]> {
  const seen = new Set<string>();
  const pending = ["main.js"];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    const text = await readFile(join(distribution, name), "utf8");
    for (const specifier of importsOf(text)) {
      if (/^\.\/[A-Za-z0-9-]+\.js$/.test(specifier)) {
        pending.push(specifier.slice(2));
      } else if (specifier !== "typescript" && !specifier.startsWith("node:")) {
        throw new Error("the analyser imports something that is not staged");
      }
    }
  }
  return [...seen].sort();
}

/**
 * The statements of compiled output that name a module: `import a from "x";`, `export { a } from
 * "x";` (the clause may run over lines) and `import "x";`. The clause has no quote and no semicolon
 * in it, so a string that holds the word "from" is not taken for one.
 */
const FROM_STATEMENT = /^(?:import|export)\b[^;"']*?\bfrom\s*"([^"]+)";$/gm;
const SIDE_EFFECT_IMPORT = /^import\s*"([^"]+)";$/gm;

function importsOf(text: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [FROM_STATEMENT, SIDE_EFFECT_IMPORT]) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

async function stageTool(destination: string): Promise<void> {
  // The package's own build, whether this runs from it or from the source in a test.
  const distribution = fileURLToPath(new URL("../dist/", import.meta.url));
  await makeDirectory(destination);
  await makeDirectory(join(destination, "dist"));
  for (const name of await analyserFiles(distribution)) {
    await writeStaged(join(destination, "dist", name), await readFile(join(distribution, name)));
  }
  await writeStaged(join(destination, "package.json"), Buffer.from('{"type":"module"}\n'));

  // The parser alone: its package.json, which says where its code is, and that one file. It makes
  // no program, so it reads none of the library files of its own.
  const parser = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
  const staged = join(destination, "node_modules", "typescript");
  await makeDirectory(join(destination, "node_modules"));
  await makeDirectory(staged);
  await makeDirectory(join(staged, "lib"));
  await writeStaged(join(staged, "package.json"), await readFile(join(parser, "package.json")));
  await writeStaged(
    join(staged, "lib", "typescript.js"),
    await readFile(join(parser, "lib", "typescript.js")),
  );
}

// ---------------------------------------------------------------------------------------------
// The repository

interface Budget {
  entries: number;
  contentBytes: number;
}

async function copyRepository(
  source: string,
  destination: string,
  limits: StagingLimits,
): Promise<void> {
  await makeDirectory(destination);
  const budget: Budget = { entries: 0, contentBytes: 0 };
  await copyDirectory(source, destination, 0, budget, limits);
}

/**
 * The entries of a directory, counted as they are read: a directory with more entries than the
 * budget has left is refused before the rest of it is listed, and is never held whole in memory.
 */
async function listDirectory(
  source: string,
  budget: Budget,
  limits: StagingLimits,
): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  try {
    const directory = await opendir(source);
    // The loop closes the directory when it ends and when it is left early.
    for await (const entry of directory) {
      budget.entries += 1;
      if (budget.entries > limits.maxEntries) throw new AnalysisError("repository_too_large");
      entries.push(entry);
    }
  } catch (error) {
    // A directory that cannot be read is not left out: an answer for a part of a repository must
    // not read as an answer for all of it.
    throw error instanceof AnalysisError ? error : new AnalysisError("repository_unreadable");
  }
  return entries;
}

async function copyDirectory(
  source: string,
  destination: string,
  depth: number,
  budget: Budget,
  limits: StagingLimits,
): Promise<void> {
  for (const entry of await listDirectory(source, budget, limits)) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      // A link is made again and points at nothing that exists: the analyser counts it and does not
      // follow it, and the target that the repository wrote is never read here or shown there.
      await symlink(".", to);
    } else if (entry.isDirectory()) {
      await makeDirectory(to);
      // A directory that the analyser never reads is made, empty, so that it is still counted.
      if (!IGNORED_DIRECTORIES.includes(entry.name)) {
        if (depth + 1 > limits.maxDepth) throw new AnalysisError("repository_too_large");
        await copyDirectory(from, to, depth + 1, budget, limits);
      }
    } else if (entry.isFile()) {
      await copyFile(from, to, budget, limits);
    }
    // Anything else (a device, a socket, a pipe) is not a file of the repository, and the analyser
    // does not list it either.
  }
}

async function copyFile(
  from: string,
  to: string,
  budget: Budget,
  limits: StagingLimits,
): Promise<void> {
  let handle: FileHandle;
  try {
    // O_NOFOLLOW: a path that was a file when the directory was read and a link now is not followed.
    handle = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    // A file that cannot be opened is not left out, for the reason that a directory is not.
    throw new AnalysisError("repository_unreadable");
  }
  try {
    const stat = await handle.stat().catch(unreadable);
    if (!stat.isFile()) return;
    if (stat.size > ANALYSIS_LIMITS.maxFileBytes) {
      // The analyser lists a file that is too large and does not read it, so only its size is
      // needed: a file of that size with nothing in it takes no space on the disk.
      const empty = await open(to, "wx", FILE_MODE);
      try {
        await empty.truncate(stat.size);
      } finally {
        await empty.close();
      }
      await chmod(to, FILE_MODE);
      return;
    }
    budget.contentBytes += stat.size;
    if (budget.contentBytes > limits.maxContentBytes)
      throw new AnalysisError("repository_too_large");
    const content = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(content, 0, stat.size, 0).catch(unreadable);
    await writeStaged(to, content.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function unreadable(): never {
  throw new AnalysisError("repository_unreadable");
}

async function makeDirectory(path: string): Promise<void> {
  await mkdir(path);
  await chmod(path, DIRECTORY_MODE);
}

async function writeStaged(path: string, content: Buffer): Promise<void> {
  // "wx": a path that exists is an error, so that nothing is written through a link or over a file.
  await writeFile(path, content, { flag: "wx", mode: FILE_MODE });
  await chmod(path, FILE_MODE);
}
