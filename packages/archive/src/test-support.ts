import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach } from "vitest";
import { ArchiveError, type ArchiveErrorCode } from "./errors.js";
import { createTarballExtractor, type ExtractionSummary } from "./extract.js";
import type { ArchiveLimits } from "./limits.js";

/**
 * A folder for one test: `dest` is the empty destination, and beside it are `outside/` (with a file
 * in it) and the folder itself, so that a test can tell whether anything was made where it must not
 * be.
 */
export interface Place {
  readonly base: string;
  readonly dest: string;
  readonly outside: string;
}

const made: string[] = [];

afterEach(async () => {
  for (const base of made.splice(0)) await rm(base, { recursive: true, force: true });
});

export const SENTINEL = "outside: do not touch";

export async function place(): Promise<Place> {
  const base = await mkdtemp(join(tmpdir(), "archive-test-"));
  made.push(base);
  const dest = join(base, "dest");
  const outside = join(base, "outside");
  await mkdir(dest);
  await mkdir(outside);
  await writeFile(join(outside, "sentinel.txt"), SENTINEL);
  return { base, dest, outside };
}

/** Every path under a directory, with its kind, sorted: `d a`, `f a/b`, `l a/c -> .`. */
export async function tree(directory: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const relative = prefix === "" ? name : `${prefix}/${name}`;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) found.push(`l ${relative} -> ${await readlink(path)}`);
    else if (stat.isDirectory()) found.push(`d ${relative}`, ...(await tree(path, relative)));
    else found.push(`f ${relative}`);
  }
  return found;
}

export async function contents(directory: string, relative: string): Promise<string> {
  return readFile(join(directory, relative), "utf8");
}

/** Unpacks the given pieces into a place and gives the summary, or the error that ended it. */
export async function unpack(
  where: Place,
  pieces: Buffer | readonly Buffer[],
  limits?: Partial<ArchiveLimits>,
): Promise<ExtractionSummary> {
  const extractor = await createTarballExtractor({
    destination: where.dest,
    ...(limits === undefined ? {} : { limits }),
  });
  try {
    const list: readonly Buffer[] = Array.isArray(pieces)
      ? (pieces as readonly Buffer[])
      : [pieces as Buffer];
    for (const piece of list) await extractor.write(piece);
    return await extractor.finish();
  } catch (error) {
    await extractor.abort();
    throw error;
  }
}

export async function failure(promise: Promise<unknown>): Promise<ArchiveError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ArchiveError) return error;
    throw error;
  }
  throw new Error("it did not fail");
}

export async function failureCode(promise: Promise<unknown>): Promise<ArchiveErrorCode> {
  return (await failure(promise)).code;
}

/** Everything that can be seen of an error, as text. */
export function everythingOf(error: Error): string {
  return [
    error.message,
    String(error),
    error.stack ?? "",
    inspect(error, { depth: 5 }),
    JSON.stringify(error),
  ].join("\n");
}

/** That nothing was made outside the destination, and that nothing there was touched. */
export async function expectNothingOutside(where: Place): Promise<string[]> {
  const problems: string[] = [];
  const base = (await readdir(where.base)).sort();
  if (base.join(",") !== "dest,outside") problems.push(`the folder holds ${base.join(",")}`);
  const outside = (await readdir(where.outside)).sort();
  if (outside.join(",") !== "sentinel.txt") problems.push(`outside holds ${outside.join(",")}`);
  if ((await contents(where.outside, "sentinel.txt")) !== SENTINEL)
    problems.push("sentinel changed");
  return problems;
}
