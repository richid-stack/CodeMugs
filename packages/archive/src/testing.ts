import { gzipSync } from "node:zlib";

/**
 * Makes tar archives for tests, including ones that no honest tool would make: a header that lies
 * about a size, a checksum that does not add up, a type that is not accepted, an extended header
 * that is not well formed. It is not used by the code that unpacks, and an archive that it makes is
 * as correct as the options say.
 */

export type FixtureType =
  | "file"
  | "directory"
  | "symlink"
  | "hardlink"
  | "character"
  | "block"
  | "fifo"
  | "contiguous"
  | "gnu-long-name"
  | "gnu-long-link"
  | "sparse"
  | "old-file";

const TYPE_FLAGS: Record<FixtureType, number> = {
  file: 0x30,
  directory: 0x35,
  symlink: 0x32,
  hardlink: 0x31,
  character: 0x33,
  block: 0x34,
  fifo: 0x36,
  contiguous: 0x37,
  "gnu-long-name": 0x4c,
  "gnu-long-link": 0x4b,
  sparse: 0x53,
  "old-file": 0x00,
};

export interface FixtureEntry {
  /** The path. A string is UTF-8. It goes in the header, and in `prefix` if it is over 100 bytes. */
  readonly name: string | Buffer;
  readonly type?: FixtureType | number;
  readonly content?: string | Buffer;
  readonly linkname?: string;
  /** The size that the header says, when it is not the size of the content. */
  readonly sizeInHeader?: number;
  /** The mode, for a test of an archive that says setuid. */
  readonly mode?: number;
  /** Extended header records, written as an entry of their own before this one. */
  readonly pax?: Readonly<Record<string, string>>;
  /** The body of an extended header as it is, when it is not to be well formed. */
  readonly rawPax?: Buffer;
  /** Fields as raw bytes: the size, the checksum, the magic. */
  readonly raw?: {
    readonly size?: Buffer;
    readonly checksum?: Buffer;
    readonly magic?: Buffer;
  };
}

export interface FixtureOptions {
  /** Blocks of zeros at the end. 2 by default, as tar writes. */
  readonly endBlocks?: number;
  /** Extra bytes after the end marker, as they are. */
  readonly after?: Buffer;
}

const BLOCK = 512;

function octal(value: number, length: number): Buffer {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) throw new Error("the number does not fit");
  return Buffer.from(`${text}\0`, "latin1");
}

function put(block: Buffer, at: number, bytes: Buffer, max: number): void {
  if (bytes.length > max) throw new Error("the field is too long");
  bytes.copy(block, at);
}

export function header(entry: {
  name: string | Buffer;
  flag: number;
  size: number;
  mode?: number;
  linkname?: string;
  raw?: FixtureEntry["raw"];
}): Buffer {
  const block = Buffer.alloc(BLOCK);
  const name = typeof entry.name === "string" ? Buffer.from(entry.name) : entry.name;
  if (name.length <= 100) {
    put(block, 0, name, 100);
  } else {
    // Split at a slash so that the last part is at most 100 bytes and the first at most 155.
    const slash = name.lastIndexOf(0x2f, name.length - 1);
    if (slash === -1 || name.length - slash - 1 > 100 || slash > 155) {
      throw new Error("the name does not fit a header: use pax");
    }
    put(block, 0, name.subarray(slash + 1), 100);
    put(block, 345, name.subarray(0, slash), 155);
  }
  put(block, 100, octal(entry.mode ?? 0o644, 8), 8);
  put(block, 108, octal(0, 8), 8);
  put(block, 116, octal(0, 8), 8);
  put(block, 124, entry.raw?.size ?? octal(entry.size, 12), 12);
  put(block, 136, octal(0, 12), 12);
  block.fill(0x20, 148, 156);
  block.writeUInt8(entry.flag, 156);
  if (entry.linkname !== undefined) put(block, 157, Buffer.from(entry.linkname), 100);
  put(block, 257, entry.raw?.magic ?? Buffer.from("ustar\x0000", "latin1"), 8);
  let sum = 0;
  for (const byte of block) sum += byte;
  const checksum = entry.raw?.checksum ?? Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `);
  put(block, 148, checksum, 8);
  return block;
}

function pad(content: Buffer): Buffer {
  const rest = content.length % BLOCK;
  return rest === 0 ? content : Buffer.concat([content, Buffer.alloc(BLOCK - rest)]);
}

/** One extended-header record: `<length> <key>=<value>\n`, with the length of all of it. */
export function paxRecord(key: string, value: string | Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(` ${key}=`), Buffer.from(value), Buffer.from("\n")]);
  let length = body.length + 1;
  while (String(length).length + body.length !== length)
    length = String(length).length + body.length;
  return Buffer.concat([Buffer.from(String(length)), body]);
}

export function tar(entries: readonly FixtureEntry[], options: FixtureOptions = {}): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    const flag = typeof entry.type === "number" ? entry.type : TYPE_FLAGS[entry.type ?? "file"];
    if (entry.pax !== undefined || entry.rawPax !== undefined) {
      const body =
        entry.rawPax ??
        Buffer.concat(Object.entries(entry.pax ?? {}).map(([key, value]) => paxRecord(key, value)));
      parts.push(header({ name: "PaxHeaders/entry", flag: 0x78, size: body.length }), pad(body));
    }
    const name =
      Buffer.from(entry.name).length > 100 && entry.pax?.["path"] !== undefined
        ? Buffer.from("PaxPath/long")
        : entry.name;
    parts.push(
      header({
        name,
        flag,
        size: entry.sizeInHeader ?? content.length,
        ...(entry.mode === undefined ? {} : { mode: entry.mode }),
        ...(entry.linkname === undefined ? {} : { linkname: entry.linkname }),
        ...(entry.raw === undefined ? {} : { raw: entry.raw }),
      }),
    );
    if (content.length > 0) parts.push(pad(content));
  }
  parts.push(Buffer.alloc(BLOCK * (options.endBlocks ?? 2)));
  if (options.after !== undefined) parts.push(options.after);
  return Buffer.concat(parts);
}

/** A global extended header, which `git archive` writes first, with the commit id. */
export function globalHeader(comment = "0123456789abcdef0123456789abcdef01234567"): Buffer {
  const body = paxRecord("comment", comment);
  return Buffer.concat([
    header({ name: "pax_global_header", flag: 0x67, size: body.length }),
    pad(body),
  ]);
}

export function gzip(bytes: Buffer): Buffer {
  return gzipSync(bytes);
}

/** A `.tar.gz` of the entries. */
export function tarball(entries: readonly FixtureEntry[], options: FixtureOptions = {}): Buffer {
  return gzip(tar(entries, options));
}

/** The bytes in pieces of the given sizes, repeated, to test an archive that arrives in parts. */
export function inPieces(bytes: Buffer, sizes: readonly number[]): Buffer[] {
  const pieces: Buffer[] = [];
  let offset = 0;
  for (let index = 0; offset < bytes.length; index += 1) {
    const size = sizes[index % sizes.length] ?? 1;
    pieces.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return pieces;
}
