/**
 * Why an archive was not unpacked. The code is the whole of the story: an archive is chosen by a
 * customer, so a message made of what it holds (a name, a link, a size claim) would be untrusted
 * text in a log (invariant 2). An error holds a fixed sentence for its code and nothing else
 * (ADR 0012).
 */
export type ArchiveErrorCode =
  /** The caller gave something that is not a destination, a limit or a chunk of bytes. */
  | "invalid_input"
  /** The bytes are not a gzip stream, or not a tar archive, or have been cut short or altered. */
  | "corrupt"
  /** An entry is of a kind that is not accepted: a hard link, a device, a pipe, or one that is unknown. */
  | "unsupported_entry"
  /** A name that would leave the destination, that repeats another, or that cannot be a path. */
  | "unsafe_path"
  /** The archive holds more than one unpacking accepts, however it is counted. */
  | "too_large"
  /** The destination could not be written. */
  | "write_failed"
  /** The caller stopped the unpacking before it ended. */
  | "aborted";

const MESSAGES: Record<ArchiveErrorCode, string> = {
  invalid_input: "the archive extraction was given input that is not valid",
  corrupt: "the archive is not a complete, valid gzip tar archive",
  unsupported_entry: "the archive holds an entry of a kind that is not accepted",
  unsafe_path: "the archive names a path that is not accepted",
  too_large: "the archive is larger than one unpacking accepts",
  write_failed: "the archive could not be written to the destination",
  aborted: "the unpacking of the archive was stopped",
};

export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;

  constructor(code: ArchiveErrorCode) {
    super(MESSAGES[code]);
    this.name = "ArchiveError";
    this.code = code;
  }
}
