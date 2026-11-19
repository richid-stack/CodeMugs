import { ArchiveError } from "./errors.js";

/**
 * A reader of the tar format: bytes in, entries out. It knows the format and nothing about the
 * disk. It accepts what `git archive` makes (ustar headers, and the extended headers of POSIX.1-2001
 * for names that do not fit) and refuses everything else, so that a repository's archive is read
 * by a small part of the format and not by all of it.
 *
 * What it accepts:
 *
 * - a header of 512 bytes with the magic `ustar` and a checksum that adds up;
 * - a regular file (`0`, or the old NUL), a directory (`5`) and a symbolic link (`2`);
 * - an extended header (`x`) for the next entry, of which it reads `path` and `size` only, and a
 *   global extended header (`g`), which it skips and does not read (the one that `git archive` puts
 *   first holds the commit id);
 * - an end marker (a block of zeros) after which there is nothing but zeros.
 *
 * What it refuses: a hard link, a device, a pipe, a sparse file, the long-name entries of GNU tar
 * and any other type (`unsupported_entry`); and everything that is not well formed, which includes
 * a checksum that does not add up, a number that is not octal, an archive that stops before its end
 * marker or in the middle of an entry, and bytes after the end marker (`corrupt`). A size that does
 * not fit in what a header can hold, or an extended header over its limit, is `too_large`.
 *
 * It never reads the target of a symbolic link: the target is text that the archive chose, and
 * nothing here or after it has a use for it.
 */

export const BLOCK_SIZE = 512;

export type EntryKind = "file" | "directory" | "symlink";

export interface TarEntry {
  readonly kind: EntryKind;
  /** The path as the archive wrote it, in bytes. Not decoded, not checked: that is the sink's. */
  readonly path: Buffer;
  /** The bytes of content that follow. Always 0 for a directory and a link. */
  readonly size: number;
}

/**
 * Where the entries go. A file's content comes as `data` calls between `entry` and `endEntry`, and
 * a call is finished before the next bytes are read, so a sink that writes to a disk is never ahead
 * of it.
 */
export interface TarSink {
  entry(entry: TarEntry): Promise<void>;
  data(chunk: Buffer): Promise<void>;
  endEntry(): Promise<void>;
}

const TYPE_FILE = 0x30; // "0"
const TYPE_FILE_OLD = 0x00;
const TYPE_DIRECTORY = 0x35; // "5"
const TYPE_SYMLINK = 0x32; // "2"
const TYPE_EXTENDED = 0x78; // "x"
const TYPE_GLOBAL = 0x67; // "g"

const NAME = { start: 0, length: 100 } as const;
const SIZE = { start: 124, length: 12 } as const;
const CHECKSUM = { start: 148, length: 8 } as const;
const TYPEFLAG = 156;
const MAGIC = { start: 257, length: 8 } as const;
const PREFIX = { start: 345, length: 155 } as const;

const MAGIC_POSIX = Buffer.from("ustar\x0000", "latin1");
const MAGIC_GNU = Buffer.from("ustar  \x00", "latin1");

/** A run of zeros to compare with, so that the check is a comparison of memory and not a loop. */
const ZEROS = Buffer.alloc(64 * 1_024);

type State = "header" | "content" | "extended" | "skip" | "padding" | "trailer";

export interface TarReaderOptions {
  /** The most bytes of one extended header. A larger one is `too_large`. */
  readonly maxExtendedHeaderBytes: number;
}

export class TarReader {
  readonly #sink: TarSink;
  readonly #maxExtended: number;
  readonly #block = Buffer.alloc(BLOCK_SIZE);
  #filled = 0;
  #state: State = "header";
  /** Bytes left of the content, of the extended header, or of what is skipped. */
  #remaining = 0;
  /** Bytes of padding that follow what is being read. */
  #padding = 0;
  #extended: Buffer[] = [];
  /** What an extended header said about the entry that comes next. */
  #pending: { path?: Buffer; size?: number } | undefined;

  constructor(sink: TarSink, options: TarReaderOptions) {
    this.#sink = sink;
    this.#maxExtended = options.maxExtendedHeaderBytes;
  }

  /** Reads bytes of the archive, which may end anywhere: in a header, in content, in padding. */
  async write(chunk: Buffer): Promise<void> {
    let offset = 0;
    while (offset < chunk.length) {
      const available = chunk.length - offset;
      switch (this.#state) {
        case "header": {
          const take = Math.min(BLOCK_SIZE - this.#filled, available);
          chunk.copy(this.#block, this.#filled, offset, offset + take);
          this.#filled += take;
          offset += take;
          if (this.#filled === BLOCK_SIZE) {
            this.#filled = 0;
            await this.#header();
          }
          break;
        }
        case "content": {
          const take = Math.min(this.#remaining, available);
          await this.#sink.data(chunk.subarray(offset, offset + take));
          offset += take;
          this.#remaining -= take;
          if (this.#remaining === 0) {
            await this.#sink.endEntry();
            this.#afterBody();
          }
          break;
        }
        case "extended": {
          const take = Math.min(this.#remaining, available);
          // A copy: the chunk belongs to the caller and is reused.
          this.#extended.push(Buffer.from(chunk.subarray(offset, offset + take)));
          offset += take;
          this.#remaining -= take;
          if (this.#remaining === 0) {
            this.#pending = parseExtended(Buffer.concat(this.#extended));
            this.#extended = [];
            this.#afterBody();
          }
          break;
        }
        case "skip": {
          const take = Math.min(this.#remaining, available);
          offset += take;
          this.#remaining -= take;
          if (this.#remaining === 0) this.#afterBody();
          break;
        }
        case "padding": {
          const take = Math.min(this.#remaining, available);
          offset += take;
          this.#remaining -= take;
          if (this.#remaining === 0) this.#state = "header";
          break;
        }
        case "trailer": {
          // After the end marker there is nothing but zeros.
          for (let at = offset; at < chunk.length; at += ZEROS.length) {
            const end = Math.min(at + ZEROS.length, chunk.length);
            if (chunk.compare(ZEROS, 0, end - at, at, end) !== 0) {
              throw new ArchiveError("corrupt");
            }
          }
          offset = chunk.length;
          break;
        }
      }
    }
  }

  /** The archive has ended. It must have ended where an archive ends, at its end marker. */
  finish(): void {
    if (this.#state !== "trailer") throw new ArchiveError("corrupt");
  }

  /** What follows a body (content, an extended header, something skipped): its padding. */
  #afterBody(): void {
    if (this.#padding > 0) {
      this.#remaining = this.#padding;
      this.#padding = 0;
      this.#state = "padding";
    } else {
      this.#state = "header";
    }
  }

  async #header(): Promise<void> {
    const block = this.#block;
    if (block.compare(ZEROS, 0, BLOCK_SIZE, 0, BLOCK_SIZE) === 0) {
      // The end marker, with an extended header that has no entry to apply to.
      if (this.#pending !== undefined) throw new ArchiveError("corrupt");
      this.#state = "trailer";
      return;
    }
    if (!checksumAdds(block)) throw new ArchiveError("corrupt");
    const magic = block.subarray(MAGIC.start, MAGIC.start + MAGIC.length);
    const posix = magic.equals(MAGIC_POSIX);
    if (!posix && !magic.equals(MAGIC_GNU)) throw new ArchiveError("corrupt");

    const type = block.readUInt8(TYPEFLAG);
    let size = readSize(block);

    if (type === TYPE_EXTENDED || type === TYPE_GLOBAL) {
      // Neither may come before an extended header that has not been used.
      if (this.#pending !== undefined) throw new ArchiveError("corrupt");
      if (size > this.#maxExtended) throw new ArchiveError("too_large");
      this.#padding = paddingOf(size);
      if (type === TYPE_GLOBAL) {
        this.#remaining = size;
        this.#state = "skip";
      } else {
        this.#remaining = size;
        this.#state = "extended";
      }
      if (size === 0) {
        if (type === TYPE_EXTENDED) this.#pending = {};
        this.#afterBody();
      }
      return;
    }

    let kind: EntryKind;
    if (type === TYPE_FILE || type === TYPE_FILE_OLD) kind = "file";
    else if (type === TYPE_DIRECTORY) kind = "directory";
    else if (type === TYPE_SYMLINK) kind = "symlink";
    else throw new ArchiveError("unsupported_entry");

    const pending = this.#pending;
    this.#pending = undefined;
    let path: Buffer;
    if (pending?.path !== undefined) {
      path = pending.path;
    } else {
      const name = cString(block, NAME.start, NAME.length);
      // `prefix` is the field of POSIX ustar. In the old GNU format those bytes hold other things.
      const prefix = posix ? cString(block, PREFIX.start, PREFIX.length) : Buffer.alloc(0);
      path = prefix.length > 0 ? Buffer.concat([prefix, Buffer.from("/"), name]) : name;
    }
    if (pending?.size !== undefined) size = pending.size;
    if (path.length === 0) throw new ArchiveError("corrupt");
    // A directory and a link have no content. A size on one is an archive that is not what it says.
    if (kind !== "file" && size !== 0) throw new ArchiveError("corrupt");

    await this.#sink.entry({ kind, path, size });
    if (size === 0) {
      await this.#sink.endEntry();
      return;
    }
    this.#remaining = size;
    this.#padding = paddingOf(size);
    this.#state = "content";
  }
}

function paddingOf(size: number): number {
  return (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
}

/** The bytes of a field up to its first NUL. */
function cString(block: Buffer, start: number, length: number): Buffer {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return Buffer.from(end === -1 ? field : field.subarray(0, end));
}

/**
 * A number written in octal, the way tar does: digits, which may be led by spaces and followed by
 * spaces and NULs. Nothing else is a number (`parseInt` would read "12abc" as 10).
 */
function octal(field: Buffer): number {
  let at = 0;
  while (at < field.length && field.readUInt8(at) === 0x20) at += 1;
  let value = 0;
  let digits = 0;
  while (at < field.length) {
    const byte = field.readUInt8(at);
    if (byte < 0x30 || byte > 0x37) break;
    value = value * 8 + (byte - 0x30);
    digits += 1;
    at += 1;
  }
  if (digits === 0) throw new ArchiveError("corrupt");
  for (; at < field.length; at += 1) {
    const byte = field.readUInt8(at);
    if (byte !== 0 && byte !== 0x20) throw new ArchiveError("corrupt");
  }
  return value;
}

function readSize(block: Buffer): number {
  // A size with its top bit set is in base 256, which is what a file of 8 GiB or more needs.
  if ((block.readUInt8(SIZE.start) & 0x80) !== 0) throw new ArchiveError("too_large");
  return octal(block.subarray(SIZE.start, SIZE.start + SIZE.length));
}

function checksumAdds(block: Buffer): boolean {
  const stored = octal(block.subarray(CHECKSUM.start, CHECKSUM.start + CHECKSUM.length));
  let sum = 0;
  for (let at = 0; at < BLOCK_SIZE; at += 1) {
    const inChecksum = at >= CHECKSUM.start && at < CHECKSUM.start + CHECKSUM.length;
    sum += inChecksum ? 0x20 : block.readUInt8(at);
  }
  return sum === stored;
}

/**
 * The records of an extended header: `<length> <key>=<value>\n`, where the length is that of the
 * whole record, itself included. Only `path` and `size` are read. A value with a NUL in it, a length
 * that is not the record's, a record that does not end in a newline, a path with nothing in it and
 * a size that is not a plain number are each `corrupt`.
 */
function parseExtended(body: Buffer): { path?: Buffer; size?: number } {
  const records: { path?: Buffer; size?: number } = {};
  let offset = 0;
  while (offset < body.length) {
    let at = offset;
    let length = 0;
    while (at < body.length) {
      const byte = body.readUInt8(at);
      if (byte < 0x30 || byte > 0x39) break;
      length = length * 10 + (byte - 0x30);
      at += 1;
    }
    if (at >= body.length || body.readUInt8(at) !== 0x20) {
      throw new ArchiveError("corrupt");
    }
    const end = offset + length;
    // The record is the digits, a space, at least "k=" and a newline.
    if (end > body.length || end < at + 1 + 2 + 1 || body.readUInt8(end - 1) !== 0x0a) {
      throw new ArchiveError("corrupt");
    }
    const record = body.subarray(at + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals < 1) throw new ArchiveError("corrupt");
    const key = record.subarray(0, equals).toString("latin1");
    const value = record.subarray(equals + 1);
    if (value.includes(0)) throw new ArchiveError("corrupt");
    if (key === "path") {
      records.path = Buffer.from(value);
    } else if (key === "size") {
      const text = value.toString("latin1");
      if (!/^[0-9]{1,16}$/.test(text)) throw new ArchiveError("corrupt");
      const size = Number(text);
      if (!Number.isSafeInteger(size)) throw new ArchiveError("too_large");
      records.size = size;
    }
    offset = end;
  }
  return records;
}
