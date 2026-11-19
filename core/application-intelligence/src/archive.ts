import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ArchiveError, createTarballExtractor, type ArchiveLimits } from "@codemugs/archive";
import { AnalysisError } from "./errors.js";
import type { RepositoryFacts } from "./facts.js";
import { analyseInSandbox, checkSandbox, type AnalyseInSandboxOptions } from "./run.js";

/** Where the pieces of an archive are given: one after the other, each when the last was taken. */
export type ArchiveSink = (chunk: Uint8Array) => Promise<void>;

export interface AnalyseArchiveOptions extends Omit<AnalyseInSandboxOptions, "repository"> {
  /**
   * Gives the repository's `.tar.gz`, piece by piece and in order, to the sink it is handed, and
   * settles when the whole has been given. It is the download: for the GitHub client it is
   * `(sink) => app.downloadTarball(owner, name, ref, { maxBytes, onChunk: sink })`. If the sink
   * throws, it must stop and throw.
   */
  readonly archive: (sink: ArchiveSink) => Promise<unknown>;
  /** Lower limits for the unpacking, for a test. They cannot be higher than `ARCHIVE_LIMITS`. */
  readonly unpackLimits?: Partial<ArchiveLimits>;
}

/**
 * Analyses the repository that an archive holds: checks the sandbox, takes the archive and unpacks
 * it as it arrives into a working copy, has it analysed in the sandbox, and removes the copy.
 *
 * What is thrown:
 *
 * - An {@link AnalysisError} for everything that is about the sandbox, the unpacking and the facts.
 *   An archive that is not a repository's (not gzip, cut short, a path that goes outside, a kind of
 *   entry that is refused) is `repository_unreadable`; one that is more than the unpacking
 *   accepts is `repository_too_large`; a disk that cannot be written is `sandbox_failed`. The
 *   code of the unpacking is not kept: it says what the archive held, and the host's log is not the
 *   place for it (ADR 0028 decision 9).
 * - What the source throws, as it threw it, when the download is what failed and the unpacking was
 *   not. It is the caller's own error and says what the caller's download says (the GitHub client's
 *   errors hold a short code and nothing else).
 * - `cleanup_failed` when the working copy could not be removed, even when something else went
 *   wrong first: it holds a copy of a customer's code and someone has to remove it.
 *
 * The sandbox is checked before anything is downloaded, so that a host that cannot run an analysis
 * does not fetch a repository first. Nothing of the repository runs here: the host unpacks bytes
 * (ADR 0028) and copies files (ADR 0025), and the parser runs only in the sandbox (invariant 8).
 */
export async function analyseArchive(options: AnalyseArchiveOptions): Promise<RepositoryFacts> {
  await checkSandbox(options);

  let checkout: string;
  try {
    checkout = await mkdtemp(join(resolve(options.workspaceRoot), "checkout-"));
  } catch {
    throw new AnalysisError("sandbox_failed");
  }
  try {
    await unpack(options, checkout);
    return await analyseInSandbox({
      driver: options.driver,
      workspaceRoot: options.workspaceRoot,
      image: options.image,
      minimumIsolation: options.minimumIsolation,
      repository: checkout,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
  } finally {
    await removeCheckout(checkout);
  }
}

/** Removes the unpacked copy. One that stays is `cleanup_failed`, said even when something else failed first. */
async function removeCheckout(checkout: string): Promise<void> {
  try {
    await rm(checkout, { recursive: true, force: true });
  } catch {
    throw new AnalysisError("cleanup_failed");
  }
}

async function unpack(options: AnalyseArchiveOptions, checkout: string): Promise<void> {
  let extractor;
  try {
    extractor = await createTarballExtractor({
      destination: checkout,
      ...(options.unpackLimits === undefined ? {} : { limits: options.unpackLimits }),
    });
  } catch (error) {
    // A limit that is not a number that is allowed is the caller's mistake, as it is for the staging.
    if (error instanceof RangeError) throw error;
    throw new AnalysisError("sandbox_failed");
  }

  // What the unpacking said, kept here: the source sees only that its sink threw, and may turn that
  // into an error of its own (the GitHub client's is `sink_failed`). The unpacking's first failure
  // is the one that it keeps and says again, so the last one that is seen here is the first.
  let unpackFailure: unknown;
  let failed = false;
  const sink: ArchiveSink = async (chunk) => {
    try {
      await extractor.write(chunk);
    } catch (error) {
      failed = true;
      unpackFailure = error;
      throw error;
    }
  };

  try {
    await options.archive(sink);
  } catch (error) {
    await extractor.abort();
    if (failed) throw analysisErrorOf(unpackFailure);
    throw error;
  }
  try {
    await extractor.finish();
  } catch (error) {
    await extractor.abort();
    throw analysisErrorOf(error);
  }
}

function analysisErrorOf(error: unknown): AnalysisError {
  if (!(error instanceof ArchiveError)) return new AnalysisError("sandbox_failed");
  switch (error.code) {
    case "too_large":
      return new AnalysisError("repository_too_large");
    case "corrupt":
    case "unsupported_entry":
    case "unsafe_path":
      return new AnalysisError("repository_unreadable");
    case "write_failed":
    case "invalid_input":
    case "aborted":
      return new AnalysisError("sandbox_failed");
  }
}
