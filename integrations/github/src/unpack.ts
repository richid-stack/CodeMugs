import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ArchiveError,
  createTarballExtractor,
  type ExtractionSummary,
  type TarballExtractor,
} from "@codemugs/archive";

/**
 * Unpacks a download as it arrives, into a directory that is made for it and removed afterwards, so
 * that the check shows that an archive that GitHub made is one that the reader of ADR 0028 accepts.
 * It reads nothing of what it unpacks, and what it says is counts and a short code, never a name.
 */
export interface Unpacking {
  /** Gives it the next bytes of the archive. It throws when they cannot be unpacked. */
  sink(chunk: Uint8Array): Promise<void>;
  /**
   * Ends the unpacking and removes the directory. `downloaded` is whether the whole archive was
   * given. Gives what is to be said, or nothing when the download failed for a reason of its own and
   * the unpacking has nothing to add.
   */
  end(downloaded: boolean): Promise<UnpackOutcome | undefined>;
}

export interface UnpackOutcome {
  readonly ok: boolean;
  readonly detail: string;
}

/** What goes in the report for an error: the code of an archive's error, and nothing else. */
const reason = (error: unknown): string =>
  error instanceof ArchiveError ? error.code : "unexpected_error";

/** Makes the directory under `root` and starts. Throws if it cannot, having left nothing behind. */
export async function startUnpacking(root: string): Promise<Unpacking> {
  const directory = await mkdtemp(join(root, "codemugs-check-"));
  let extractor: TarballExtractor;
  try {
    extractor = await createTarballExtractor({ destination: directory });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  // The unpacking keeps its first failure and says it again, so the last seen is the first.
  let failure: unknown;
  let failed = false;
  return {
    async sink(chunk) {
      try {
        await extractor.write(chunk);
      } catch (error) {
        failed = true;
        failure = error;
        throw error;
      }
    },
    async end(downloaded) {
      // After a failure, finishing throws that failure again, and that is what is kept.
      let summary: ExtractionSummary | undefined;
      if (downloaded) {
        try {
          summary = await extractor.finish();
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
      // That a file could not be closed is not said: what is being reported matters more, and the
      // directory is removed next.
      if (summary === undefined) await extractor.abort().catch(() => undefined);
      let removed = true;
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        removed = false;
      }
      // A copy that could not be removed is said even when something else went wrong first.
      if (failed) {
        const said = reason(failure);
        return { ok: false, detail: removed ? said : `${said}, the copy could not be removed` };
      }
      if (summary === undefined) {
        return removed ? undefined : { ok: false, detail: "the copy could not be removed" };
      }
      const counts = `files ${String(summary.files)}, directories ${String(summary.directories)}, content ${String(summary.contentBytes)} bytes`;
      return removed
        ? { ok: summary.files > 0, detail: `${counts}, copy removed` }
        : { ok: false, detail: `${counts}, the copy could not be removed` };
    },
  };
}
