// Shared by this package's tests. Not part of the build.
import { parseRepositoryFacts, type RepositoryFacts } from "@codemugs/application-intelligence";
import type { ClaimedJob, LongJobContext } from "@codemugs/jobs";
import type { AnalysisPlan } from "@codemugs/repository-analysis";
import type { RepositoryReader } from "./analyse-job.js";

/** Facts of a repository of two files and one import, as the analyser would give them. */
export function sampleFacts(extra: { readonly files?: readonly string[] } = {}): RepositoryFacts {
  const paths = ["src/a.ts", "src/b.ts", ...(extra.files ?? [])];
  const files = paths.map((path) => ({
    path,
    language: "typescript",
    role: "source",
    bytes: 100,
    lines: 10,
  }));
  return parseRepositoryFacts(
    JSON.stringify({
      version: 1,
      analyser: { name: "codemugs-ts-analyser", typescript: "6.0.3" },
      limits: {
        filesSeen: files.length,
        filesListed: files.length,
        filesParsed: files.length,
        bytesRead: files.length * 100,
        truncated: [],
        skipped: {
          symlink: 0,
          tooLarge: 0,
          unreadable: 0,
          ignoredDirectory: 0,
          badName: 0,
          parseFailed: 0,
          invalidSpecifier: 0,
        },
      },
      files,
      packages: [],
      imports: [
        {
          from: "src/a.ts",
          specifier: "./b",
          kind: "static",
          target: { type: "internal", path: "src/b.ts" },
          line: 1,
        },
      ],
      envVars: [],
      routes: [],
      frameworks: [],
    }),
  );
}

export const COMMIT = "0123456789abcdef0123456789abcdef01234567";

export const PLAN: AnalysisPlan = {
  requestId: "00000000-0000-4000-8000-0000000000a1",
  projectId: "00000000-0000-4000-8000-0000000000b2",
  ref: "main",
  installationId: 11,
  owner: "acme",
  name: "shop",
};

export const JOB: ClaimedJob = {
  jobId: "00000000-0000-4000-8000-0000000000c3",
  organisationId: "00000000-0000-4000-8000-0000000000d4",
  kind: "repository.analyse",
  subjectId: PLAN.requestId,
  attempt: 1,
  maxAttempts: 3,
  leaseToken: "00000000-0000-4000-8000-0000000000e5",
};

/** A context whose `read` gives what the test says instead of asking a database. */
export function contextFor(
  plan: AnalysisPlan | undefined,
  signal: AbortSignal = new AbortController().signal,
): LongJobContext {
  return { signal, read: (() => Promise.resolve(plan)) as LongJobContext["read"] };
}

export interface Calls {
  readonly opened: Array<{ installationId: number; name: string }>;
  readonly commitIds: Array<{ owner: string; name: string; ref: string }>;
  readonly downloads: Array<{ owner: string; name: string; ref: string; maxBytes: number }>;
}

/** A GitHub that records what it is asked, and answers with a commit and some bytes. */
export function fakeGitHub(
  overrides: Partial<{
    commit: string | (() => string);
    getCommitId: RepositoryReader["getCommitId"];
    downloadTarball: RepositoryReader["downloadTarball"];
  }> = {},
): {
  calls: Calls;
  openRepository: (installationId: number, name: string) => Promise<RepositoryReader>;
} {
  const calls: Calls = { opened: [], commitIds: [], downloads: [] };
  const commit = (): string =>
    typeof overrides.commit === "function" ? overrides.commit() : (overrides.commit ?? COMMIT);
  const reader: RepositoryReader = {
    getCommitId:
      overrides.getCommitId ??
      ((owner, name, ref) => {
        calls.commitIds.push({ owner, name, ref });
        return Promise.resolve(commit());
      }),
    downloadTarball:
      overrides.downloadTarball ??
      (async (owner, name, ref, options) => {
        calls.downloads.push({ owner, name, ref, maxBytes: options.maxBytes });
        await options.onChunk?.(new Uint8Array([1, 2, 3]));
        return { bytes: 3, sha256: "0".repeat(64) };
      }),
  };
  return {
    calls,
    openRepository: (installationId, name) => {
      calls.opened.push({ installationId, name });
      return Promise.resolve(reader);
    },
  };
}
