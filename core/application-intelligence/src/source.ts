import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { IGNORED_DIRECTORIES } from "./constants.js";
import type { AnalysisLimits } from "./limits.js";
import { hasControlCharacter } from "./text.js";

/** One file of the repository, as the analyser sees it: where it is, how big, and how to read it. */
export interface SourceFile {
  readonly path: string;
  readonly bytes: number;
  read(): Promise<Buffer>;
}

/** What was left out, and why. Every number is a count of things, never of what they held. */
export interface Skips {
  symlink: number;
  tooLarge: number;
  unreadable: number;
  ignoredDirectory: number;
  badName: number;
  parseFailed: number;
  invalidSpecifier: number;
}

export function newSkips(): Skips {
  return {
    symlink: 0,
    tooLarge: 0,
    unreadable: 0,
    ignoredDirectory: 0,
    badName: 0,
    parseFailed: 0,
    invalidSpecifier: 0,
  };
}

/** The files of a repository, in a fixed order, and what had to be left out to get them. */
export interface AnalysisSource {
  /**
   * Every file that can be listed, up to `maxFiles`. `seen` is those, and the ones that were left
   * out only because of that limit: it is more than `files` when the limit cut the list short, and
   * a file that was left out for another reason (a name, a read that failed) is in `skips`.
   */
  list(
    limits: AnalysisLimits,
  ): Promise<{ files: SourceFile[]; seen: number; skips: Skips; depthExceeded: boolean }>;
}

/** A name that a fact can carry: not too long, and with no control character or backslash. */
export function isUsablePath(path: string, limits: AnalysisLimits): boolean {
  return (
    path.length > 0 &&
    path.length <= limits.maxPathLength &&
    !hasControlCharacter(path) &&
    !path.includes("\\")
  );
}

/**
 * The files under a directory. Symbolic links are never followed, and are counted (a link out of
 * the repository is how a repository reads a file that is not its own), and so is every other
 * thing that is left out: ignored directories, names that cannot be carried, files that cannot be
 * read. Only regular files are listed. The order is fixed, so that the same directory gives the
 * same answer.
 */
export function directorySource(root: string): AnalysisSource {
  return {
    async list(limits) {
      const files: SourceFile[] = [];
      const skips = newSkips();
      let droppedForLimit = 0;
      let depthExceeded = false;

      const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch {
          // A directory below the root that cannot be read is left out and counted. The root is
          // not: an answer for a repository that could not be opened would read as an empty one.
          if (depth === 0) throw new Error("the repository cannot be read");
          skips.unreadable += 1;
          return;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
          const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
          if (entry.isSymbolicLink()) {
            skips.symlink += 1;
          } else if (entry.isDirectory()) {
            if (IGNORED_DIRECTORIES.includes(entry.name)) {
              skips.ignoredDirectory += 1;
            } else if (depth + 1 > limits.maxDirectoryDepth) {
              depthExceeded = true;
            } else if (!isUsablePath(path, limits)) {
              skips.badName += 1;
            } else {
              await walk(join(directory, entry.name), path, depth + 1);
            }
          } else if (entry.isFile()) {
            if (!isUsablePath(path, limits)) {
              skips.badName += 1;
              continue;
            }
            if (files.length >= limits.maxFiles) {
              droppedForLimit += 1;
              continue;
            }
            let bytes: number;
            try {
              bytes = (await lstat(join(directory, entry.name))).size;
            } catch {
              skips.unreadable += 1;
              continue;
            }
            const absolute = join(directory, entry.name);
            files.push({
              path,
              bytes,
              read: () => readAtMost(absolute, limits.maxFileBytes, bytes),
            });
          }
        }
      };

      await walk(root, "", 0);
      return { files, seen: files.length + droppedForLimit, skips, depthExceeded };
    },
  };
}

/**
 * Reads a file, and no more than the limit, and no more than a byte beyond the size that it was
 * listed with: a file that grows after it was measured gives a prefix, and cannot make the buffer
 * as large as the limit for a file that is small.
 */
async function readAtMost(path: string, limit: number, listedBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const length = Math.min(limit, listedBytes + 1);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** A repository held in memory, for tests of the analysis. Paths are given as written. */
export function memorySource(contents: Readonly<Record<string, string>>): AnalysisSource {
  return {
    list(limits) {
      const skips = newSkips();
      const files: SourceFile[] = [];
      let droppedForLimit = 0;
      for (const path of Object.keys(contents).sort()) {
        if (!isUsablePath(path, limits)) {
          skips.badName += 1;
        } else if (files.length < limits.maxFiles) {
          const buffer = Buffer.from(contents[path] ?? "", "utf8");
          files.push({ path, bytes: buffer.length, read: () => Promise.resolve(buffer) });
        } else {
          droppedForLimit += 1;
        }
      }
      return Promise.resolve({
        files,
        seen: files.length + droppedForLimit,
        skips,
        depthExceeded: false,
      });
    },
  };
}
