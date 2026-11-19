const MIB = 1_048_576;

/**
 * The most that one unpacking accepts. An archive is chosen by a customer, so every one of these is
 * a bound on something that the archive can claim or cause: how many things it makes, how many bytes
 * it writes, how far it expands, how deep and how long its names are.
 *
 * The first two are the host's staging limits (`STAGING_LIMITS` in `@codemugs/application-intelligence`),
 * so that what is unpacked is never more than what staging then accepts. A caller can lower a limit
 * and never raise it.
 */
export const ARCHIVE_LIMITS = Object.freeze({
  /** Files, directories and links together, including the directories that a path implies. */
  maxEntries: 200_000,
  /** The bytes of file content that are written. */
  maxContentBytes: 512 * MIB,
  /**
   * What the gzip stream may expand to, headers and padding included. It is above the content limit
   * because a tar archive spends 512 bytes or more on each entry, and it is what stops a stream that
   * is small and expands to a great deal.
   */
  maxDecompressedBytes: 1_024 * MIB,
  /** Directories from the top of the repository to an entry. */
  maxDepth: 100,
  /** One whole path, in bytes. */
  maxPathBytes: 1_024,
  /** One name in a path, in bytes (what Linux allows). */
  maxNameBytes: 255,
  /** The bytes of every distinct path, which is what the unpacking holds in memory. */
  maxTotalPathBytes: 32 * MIB,
  /** One extended header (the place where a long name is kept). */
  maxExtendedHeaderBytes: 64 * 1_024,
});

export type ArchiveLimits = { -readonly [Key in keyof typeof ARCHIVE_LIMITS]: number };

export function resolveLimits(overrides: Partial<ArchiveLimits> | undefined): ArchiveLimits {
  const limits: ArchiveLimits = { ...ARCHIVE_LIMITS };
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (!(name in limits)) throw new RangeError("unknown limit");
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError("a limit must be a whole number that is not negative");
    }
    const key = name as keyof ArchiveLimits;
    limits[key] = Math.min(value, ARCHIVE_LIMITS[key]);
  }
  return limits;
}
