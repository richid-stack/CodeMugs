/**
 * Unpacking a repository's `.tar.gz` into a directory, from bytes that arrive in pieces, with every
 * name, size and count bounded (ADR 0028). It is for archives that a customer chose, which are
 * untrusted: it makes files, directories and links to nothing, and nothing outside its destination.
 */
export { ArchiveError, type ArchiveErrorCode } from "./errors.js";
export {
  createTarballExtractor,
  extractTarball,
  type ExtractOptions,
  type ExtractionSummary,
  type TarballExtractor,
} from "./extract.js";
export { ARCHIVE_LIMITS, type ArchiveLimits } from "./limits.js";
