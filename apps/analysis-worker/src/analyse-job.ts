import type { ArchiveSink, RepositoryFacts } from "@codemugs/application-intelligence";
import { ARCHIVE_LIMITS } from "@codemugs/archive";
import type { GitHubApp, InstallationClient } from "@codemugs/github";
import { JobFailure, longJob, type LongJob } from "@codemugs/jobs";
import { ANALYSE_JOB_KIND, readAnalysisPlan } from "@codemugs/repository-analysis";
import { saveAnalysis } from "@codemugs/system-graph";
import { failureOf } from "./failure.js";

/** What the job needs of GitHub: the commit that a ref names, and that commit as a gzipped tar. */
export type RepositoryReader = Pick<InstallationClient, "getCommitId" | "downloadTarball">;

export interface AnalyseJobDependencies {
  /**
   * A reader for one repository of an installation, with a token that is narrowed to it and to
   * read access. See {@link githubRepositories} for the one that asks GitHub.
   */
  readonly openRepository: (installationId: number, name: string) => Promise<RepositoryReader>;
  /**
   * Analyses the repository that an archive holds, in the sandbox, and gives its facts. It is given
   * the download as a function that hands the archive to a sink, as `analyseArchive` takes it. Where
   * the sandbox is, what image it runs and how much it must isolate are the caller's to say: this
   * job runs nothing itself (invariant 8).
   */
  readonly analyse: (archive: (sink: ArchiveSink) => Promise<unknown>) => Promise<RepositoryFacts>;
  /** The most that a download may be, in bytes. The limit of the unpacking by default. */
  readonly maxArchiveBytes?: number;
}

/** The reader that asks GitHub: a token for one repository of the installation, and a client for it. */
export function githubRepositories(
  app: Pick<GitHubApp, "createInstallationToken" | "forInstallation">,
): AnalyseJobDependencies["openRepository"] {
  return async (installationId, name) =>
    app.forInstallation(await app.createInstallationToken(installationId, name));
}

/**
 * The job that analyses a repository ({@link ANALYSE_JOB_KIND}), as a job that takes long (ADR 0030):
 * no transaction is open while it downloads and analyses, and the graph is stored in the one that
 * also completes the job.
 *
 * What it does, for the request that the job's subject names:
 *
 * 1. Reads the plan of the request, in the job's organisation: the installation, the repository
 *    and the ref. A job with no request is `request_not_found` and is not tried again.
 * 2. Asks GitHub for the commit that the ref names **now**, and analyses that commit and not the
 *    ref, so that the run says exactly what was analysed even if the branch moves meanwhile. A
 *    second try may therefore analyse a later commit than the first would have; nothing is stored
 *    until one try is done.
 * 3. Downloads it and has it analysed in the sandbox. Whatever the repository holds is untrusted
 *    data (invariant 2) and nothing of it runs here.
 * 4. Returns what to store: the run, with the request's id as its id, which is the key that makes
 *    a repeat harmless (ADR 0026), and the commit as its revision.
 *
 * The work is checked against the lease between its steps and not inside them: a step cannot be
 * stopped yet, so the lease has to be longer than the work (ADR 0030).
 */
export function analyseJob(dependencies: AnalyseJobDependencies): LongJob {
  const maxBytes = dependencies.maxArchiveBytes ?? ARCHIVE_LIMITS.maxCompressedBytes;
  return longJob(async (job, context) => {
    try {
      const plan =
        job.subjectId === null
          ? undefined
          : await context.read((client) => readAnalysisPlan(client, job.subjectId as string));
      if (plan === undefined) throw new JobFailure("request_not_found", { retryable: false });
      const stillHeld = (): void => {
        if (context.signal.aborted) throw new JobFailure("lease_lost", { retryable: false });
      };

      const repository = await dependencies.openRepository(plan.installationId, plan.name);
      stillHeld();
      const commit = await repository.getCommitId(plan.owner, plan.name, plan.ref);
      stillHeld();
      const facts = await dependencies.analyse((sink) =>
        repository.downloadTarball(plan.owner, plan.name, commit, { maxBytes, onChunk: sink }),
      );
      stillHeld();

      return async (client) => {
        try {
          await saveAnalysis(client, {
            runId: plan.requestId,
            projectId: plan.projectId,
            revision: commit,
            facts,
          });
        } catch (error) {
          throw failureOf(error) ?? error;
        }
      };
    } catch (error) {
      throw failureOf(error) ?? error;
    }
  });
}

/** The handlers of this worker, by the kind of job that they do. */
export function analysisHandlers(
  dependencies: AnalyseJobDependencies,
): Readonly<Record<string, LongJob>> {
  return Object.freeze({ [ANALYSE_JOB_KIND]: analyseJob(dependencies) });
}
