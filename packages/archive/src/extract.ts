import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, symlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createGunzip, type Gunzip } from "node:zlib";
import { ArchiveError } from "./errors.js";
import { resolveLimits, type ArchiveLimits } from "./limits.js";
import { TarReader, type TarEntry, type TarSink } from "./tar.js";

/**
 * Unpacks a repository's `.tar.gz` into an empty directory, from bytes that arrive in pieces.
 *
 * This is host code that reads a customer's archive, and it is written to be the smallest thing that
 * can do that safely (ADR 0028). It decompresses with Node's zlib, reads the tar format with
 * `TarReader` (which accepts a small part of it), and makes only what it can account for:
 *
 * - **Every path is checked as text and then as a place.** It is split into names. A name that is
 *   empty, `.` or `..`, that is not UTF-8, or that is over a limit is refused, so no path can leave
 *   the destination and none can be absolute. The first name is the archive's own top directory (the
 *   one that GitHub puts every file under), which is removed, and every entry must have the same one.
 * - **Nothing is written through anything that the archive made.** The kind of every path that has
 *   been made is kept in memory. A path whose parent is a file or a link, a name that was already
 *   made as a file or a link, and a file where a directory is, are `unsafe_path`. A parent that the
 *   archive did not give an entry for is made, as a directory, and only if nothing else is there.
 * - **Links are made again and point at nothing.** A symbolic link is made to `.`, as staging makes
 *   it, and the target that the archive wrote is never read. A hard link, a device and a pipe are
 *   refused by the reader.
 * - **Files are made with `O_CREAT | O_EXCL | O_NOFOLLOW`**, with a mode of our own (0600, and 0700
 *   for a directory), and not the archive's: a mode in an archive can say setuid.
 * - **Everything is bounded** (`ARCHIVE_LIMITS`): the entries made, the bytes written, how far the
 *   gzip stream may expand (checked as it comes out, so a small stream that expands to a great deal
 *   stops at the limit and not after it), the depth, the length of a name and of a path, and the
 *   memory that the paths take.
 *
 * It makes nothing outside the destination, runs nothing and keeps no name that the archive chose
 * in an error or a result. When it fails, what it made is left where it is: the caller made the
 * directory and removes it.
 */

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const CREATE_FILE =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export interface ExtractOptions {
  /** An absolute path to a directory that exists and is empty. */
  readonly destination: string;
  /** Lower limits for a test. They cannot be higher than `ARCHIVE_LIMITS`. */
  readonly limits?: Partial<ArchiveLimits>;
}

/** What was made. Counts and sizes only: no name that the archive chose. */
export interface ExtractionSummary {
  /** Files, directories and links made. */
  readonly entries: number;
  readonly files: number;
  readonly directories: number;
  readonly links: number;
  /** Bytes of file content written. */
  readonly contentBytes: number;
  /** Bytes that the gzip stream expanded to. */
  readonly decompressedBytes: number;
}

export interface TarballExtractor {
  /** Gives the next bytes of the `.tar.gz`. Calls are taken one after the other, in order. */
  write(chunk: Uint8Array): Promise<void>;
  /** The bytes are all given. Resolves when the archive is complete and everything is written. */
  finish(): Promise<ExtractionSummary>;
  /** Stops, and releases what is open. Safe to call at any time and more than once. */
  abort(): Promise<void>;
  /** What has been seen so far. For a test and for a log: counts only. */
  progress(): ExtractionSummary;
}

export async function createTarballExtractor(options: ExtractOptions): Promise<TarballExtractor> {
  const limits = resolveLimits(options.limits);
  await checkDestination(options.destination);
  return new Extraction(options.destination, limits);
}

/** Unpacks a whole archive from a source of bytes. Stops the unpacking if the source fails. */
export async function extractTarball(
  source: AsyncIterable<Uint8Array>,
  options: ExtractOptions,
): Promise<ExtractionSummary> {
  const extractor = await createTarballExtractor(options);
  try {
    for await (const chunk of source) await extractor.write(chunk);
    return await extractor.finish();
  } catch (error) {
    await extractor.abort();
    throw error;
  }
}

async function checkDestination(destination: unknown): Promise<void> {
  if (typeof destination !== "string" || !isAbsolute(destination)) {
    throw new ArchiveError("invalid_input");
  }
  try {
    // lstat: a link to a directory is not the directory that the caller made.
    if (!(await lstat(destination)).isDirectory()) throw new ArchiveError("invalid_input");
    if ((await readdir(destination)).length > 0) throw new ArchiveError("invalid_input");
  } catch (error) {
    throw error instanceof ArchiveError ? error : new ArchiveError("invalid_input");
  }
}

class Extraction implements TarballExtractor {
  readonly #limits: ArchiveLimits;
  readonly #gunzip: Gunzip = createGunzip({ chunkSize: 64 * 1_024 });
  readonly #writer: DiskWriter;
  readonly #reader: TarReader;
  readonly #pump: Promise<void>;
  #queue: Promise<unknown> = Promise.resolve();
  /** What the writes that are waiting count for (see `maxPendingBytes`). */
  #pending = 0;
  /** The bytes of the `.tar.gz` that were given, all together. */
  #given = 0;
  #decompressed = 0;
  #error: ArchiveError | undefined;
  #ended = false;
  #done = false;

  constructor(destination: string, limits: ArchiveLimits) {
    this.#limits = limits;
    this.#writer = new DiskWriter(destination, limits);
    this.#reader = new TarReader(this.#writer, {
      maxExtendedHeaderBytes: limits.maxExtendedHeaderBytes,
    });
    this.#pump = this.#run();
  }

  /** Reads what the decompressor gives, as it gives it, and stops it at the first failure. */
  async #run(): Promise<void> {
    try {
      for await (const chunk of this.#gunzip) {
        const bytes = chunk as Buffer;
        this.#decompressed += bytes.length;
        if (this.#decompressed > this.#limits.maxDecompressedBytes) {
          throw new ArchiveError("too_large");
        }
        await this.#reader.write(bytes);
      }
      this.#reader.finish();
    } catch (error) {
      // What the decompressor throws is a stream that is not gzip, or is cut short or altered. What
      // the reader and the writer throw is already an ArchiveError.
      this.#fail(error instanceof ArchiveError ? error : new ArchiveError("corrupt"));
    }
  }

  /** A method and not a check on the field, so that the type is not narrowed by an earlier check. */
  #throwIfFailed(): void {
    if (this.#error !== undefined) throw this.#error;
  }

  #fail(error: ArchiveError): void {
    this.#error ??= error;
    this.#gunzip.destroy();
  }

  write(chunk: Uint8Array): Promise<void> {
    // Both limits are checked as the write is made, and not when its turn comes, so that a caller
    // that makes them without waiting is stopped before the queue holds more than the limit.
    const size = chunk instanceof Uint8Array ? chunk.byteLength : 0;
    this.#given += size;
    if (this.#given > this.#limits.maxCompressedBytes) return this.#refuse("too_large");
    // What is waiting is counted by more than its bytes, so that a great many empty writes are too.
    // A write that nothing waits beside is taken whatever its size: the caller holds it already.
    const cost = size + PENDING_WRITE_COST;
    if (this.#pending > 0 && this.#pending + cost > this.#limits.maxPendingBytes) {
      return this.#refuse("invalid_input");
    }
    this.#pending += cost;
    const run = this.#queue
      .then(() => this.#write(chunk))
      .finally(() => {
        this.#pending -= cost;
      });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Refuses a write, and fails the unpacking: bytes that were not taken leave a gap in the archive,
   * so no more are taken, and the first failure is the one that stays.
   */
  #refuse(code: "too_large" | "invalid_input"): Promise<void> {
    const error = new ArchiveError(code);
    this.#fail(error);
    return Promise.reject(this.#error ?? error);
  }

  async #write(chunk: Uint8Array): Promise<void> {
    this.#throwIfFailed();
    if (!(chunk instanceof Uint8Array) || this.#ended) throw new ArchiveError("invalid_input");
    const input = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    // The decompressor does not call back for a chunk that it rejects, so the end of the pump (which
    // is where its failure is seen) is waited for as well.
    const written = new Promise<void>((resolve) => {
      this.#gunzip.write(input, () => {
        resolve();
      });
    });
    await Promise.race([written, this.#pump]);
    this.#throwIfFailed();
  }

  async finish(): Promise<ExtractionSummary> {
    await this.#queue;
    this.#throwIfFailed();
    if (this.#ended) throw new ArchiveError("invalid_input");
    this.#ended = true;
    this.#gunzip.end();
    await this.#pump;
    await this.#writer.close();
    this.#throwIfFailed();
    this.#done = true;
    return this.progress();
  }

  async abort(): Promise<void> {
    if (this.#done) return;
    this.#fail(new ArchiveError("aborted"));
    await this.#pump;
    await this.#writer.close();
  }

  progress(): ExtractionSummary {
    return { ...this.#writer.summary(), decompressedBytes: this.#decompressed };
  }
}

/** What a write that is waiting counts for besides its bytes: its promise and what it holds. */
const PENDING_WRITE_COST = 1_024;

type Kind = "directory" | "file" | "symlink";

/** Makes what the reader finds, if the path is one that can be made. */
class DiskWriter implements TarSink {
  readonly #destination: string;
  readonly #limits: ArchiveLimits;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  /** The kind of every path made, relative to the destination. */
  readonly #made = new Map<string, Kind>();
  #root: string | undefined;
  #pathBytes = 0;
  #files = 0;
  #directories = 0;
  #links = 0;
  #contentBytes = 0;
  #handle: FileHandle | undefined;

  constructor(destination: string, limits: ArchiveLimits) {
    this.#destination = destination;
    this.#limits = limits;
  }

  summary(): Omit<ExtractionSummary, "decompressedBytes"> {
    return {
      entries: this.#files + this.#directories + this.#links,
      files: this.#files,
      directories: this.#directories,
      links: this.#links,
      contentBytes: this.#contentBytes,
    };
  }

  async entry(entry: TarEntry): Promise<void> {
    const names = this.#names(entry);
    // The archive's own top directory is the destination, which is already there.
    if (names.length === 0) return;

    // The directories above it: made if nothing is there, and nothing else is accepted there.
    for (let depth = 1; depth < names.length; depth += 1) {
      const path = names.slice(0, depth).join("/");
      const kind = this.#made.get(path);
      if (kind === undefined) await this.#make(path, "directory");
      else if (kind !== "directory") throw new ArchiveError("unsafe_path");
    }

    const path = names.join("/");
    const existing = this.#made.get(path);
    if (entry.kind === "directory") {
      if (existing === undefined) await this.#make(path, "directory");
      else if (existing !== "directory") throw new ArchiveError("unsafe_path");
    } else {
      // A name that is already a file, a link or a directory is made twice, which no honest
      // archive does and which is how a name is pointed at something else.
      if (existing !== undefined) throw new ArchiveError("unsafe_path");
      if (entry.kind === "symlink") {
        await this.#make(path, "symlink");
      } else {
        if (this.#contentBytes + entry.size > this.#limits.maxContentBytes) {
          throw new ArchiveError("too_large");
        }
        this.#contentBytes += entry.size;
        await this.#make(path, "file");
      }
    }
  }

  async data(chunk: Buffer): Promise<void> {
    const handle = this.#handle;
    // The reader gives content only after a file, which has a handle: this is not reached.
    if (handle === undefined) throw new ArchiveError("corrupt");
    try {
      let written = 0;
      while (written < chunk.length) {
        const result = await handle.write(chunk, written, chunk.length - written, null);
        written += result.bytesWritten;
      }
    } catch {
      throw new ArchiveError("write_failed");
    }
  }

  async endEntry(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    if (handle === undefined) return;
    try {
      await handle.close();
    } catch {
      throw new ArchiveError("write_failed");
    }
  }

  /**
   * The names of an entry's path below the archive's top directory: none for the top directory.
   * Every refusal here is about the path as text, before anything is made.
   */
  #names(entry: TarEntry): string[] {
    if (entry.path.length > this.#limits.maxPathBytes) throw new ArchiveError("too_large");
    let text: string;
    try {
      text = this.#decoder.decode(entry.path);
    } catch {
      throw new ArchiveError("unsafe_path");
    }
    const names = text.split("/");
    // One slash at the end of a directory's path is how tar writes it.
    if (entry.kind === "directory" && names.at(-1) === "") names.pop();
    for (const name of names) {
      if (name === "" || name === "." || name === "..") throw new ArchiveError("unsafe_path");
      if (Buffer.byteLength(name) > this.#limits.maxNameBytes) throw new ArchiveError("too_large");
    }
    const [root, ...below] = names;
    if (root === undefined) throw new ArchiveError("unsafe_path");
    this.#root ??= root;
    // Every entry is under the one top directory, which is the archive's and is not ours.
    if (root !== this.#root) throw new ArchiveError("unsafe_path");
    if (below.length === 0) {
      if (entry.kind !== "directory") throw new ArchiveError("unsafe_path");
      return [];
    }
    // The directories from the top to a directory, or to the one that a file is in.
    const levels = entry.kind === "directory" ? below.length : below.length - 1;
    if (levels > this.#limits.maxDepth) throw new ArchiveError("too_large");
    return below;
  }

  async #make(path: string, kind: Kind): Promise<void> {
    const entries = this.#files + this.#directories + this.#links;
    if (entries + 1 > this.#limits.maxEntries) throw new ArchiveError("too_large");
    this.#pathBytes += Buffer.byteLength(path);
    if (this.#pathBytes > this.#limits.maxTotalPathBytes) throw new ArchiveError("too_large");

    const absolute = join(this.#destination, ...path.split("/"));
    try {
      if (kind === "directory") {
        await mkdir(absolute, { mode: DIRECTORY_MODE });
      } else if (kind === "symlink") {
        // Made again, to nothing: the target in the archive is not read.
        await symlink(".", absolute);
      } else {
        this.#handle = await open(absolute, CREATE_FILE, FILE_MODE);
      }
    } catch {
      throw new ArchiveError("write_failed");
    }
    this.#made.set(path, kind);
    if (kind === "directory") this.#directories += 1;
    else if (kind === "symlink") this.#links += 1;
    else this.#files += 1;
  }
}
