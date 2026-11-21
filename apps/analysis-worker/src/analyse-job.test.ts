import { AnalysisError } from "@codemugs/application-intelligence";
import { ARCHIVE_LIMITS } from "@codemugs/archive";
import { GitHubError } from "@codemugs/github";
import { JobFailure, type JobCommit } from "@codemugs/jobs";
import { describe, expect, it, vi } from "vitest";
import { analyseJob, githubRepositories, type AnalyseJobDependencies } from "./analyse-job.js";
import { COMMIT, JOB, PLAN, contextFor, fakeGitHub, sampleFacts } from "./test-support.js";

const run = (
  dependencies: AnalyseJobDependencies,
  options: Parameters<typeof contextFor> = [PLAN],
  job = JOB,
): Promise<JobCommit> => analyseJob(dependencies).long(job, contextFor(...options));

const failureOf = async (work: Promise<unknown>): Promise<JobFailure> => {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(JobFailure);
    return error as JobFailure;
  }
  throw new Error("expected a failure, and there was none");
};

describe("the job that analyses a repository, without a database", () => {
  it("looks up the commit that the ref names and downloads that commit, not the ref", async () => {
    const github = fakeGitHub();
    const analyse = vi.fn(async (archive: Parameters<AnalyseJobDependencies["analyse"]>[0]) => {
      const chunks: Uint8Array[] = [];
      await archive((chunk) => {
        chunks.push(chunk);
        return Promise.resolve();
      });
      expect(chunks).toHaveLength(1);
      return sampleFacts();
    });
    const commit = await run({ openRepository: github.openRepository, analyse });
    expect(typeof commit).toBe("function");
    expect(github.calls.opened).toEqual([{ installationId: 11, name: "shop" }]);
    expect(github.calls.commitIds).toEqual([{ owner: "acme", name: "shop", ref: "main" }]);
    expect(github.calls.downloads).toEqual([
      { owner: "acme", name: "shop", ref: COMMIT, maxBytes: ARCHIVE_LIMITS.maxCompressedBytes },
    ]);
  });

  it("downloads no more than it was told to", async () => {
    const github = fakeGitHub();
    await run({
      openRepository: github.openRepository,
      analyse: async (archive) => {
        await archive(() => Promise.resolve());
        return sampleFacts();
      },
      maxArchiveBytes: 1_000,
    });
    expect(github.calls.downloads.map((download) => download.maxBytes)).toEqual([1_000]);
  });

  it.each([
    [
      "a job that has no subject",
      [PLAN] as Parameters<typeof contextFor>,
      { ...JOB, subjectId: null },
    ],
    ["a subject that is no request", [undefined] as Parameters<typeof contextFor>, JOB],
  ])("fails %s at once, and asks GitHub for nothing", async (_label, options, job) => {
    const github = fakeGitHub();
    const analyse = vi.fn();
    const failure = await failureOf(
      run({ openRepository: github.openRepository, analyse }, options, job),
    );
    expect(failure.code).toBe("request_not_found");
    expect(failure.retryable).toBe(false);
    expect(github.calls.opened).toEqual([]);
    expect(analyse).not.toHaveBeenCalled();
  });

  describe("when the lease has run out", () => {
    const abortedAfter = (stage: "open" | "commit" | "analyse") => {
      const controller = new AbortController();
      const github = fakeGitHub();
      const analyse = vi.fn(() => {
        if (stage === "analyse") controller.abort();
        return Promise.resolve(sampleFacts());
      });
      return {
        controller,
        github,
        analyse,
        dependencies: {
          openRepository: (installationId: number, name: string) => {
            if (stage === "open") controller.abort();
            return github.openRepository(installationId, name);
          },
          analyse: ((archive) => {
            void archive;
            return analyse();
          }) as AnalyseJobDependencies["analyse"],
        } satisfies AnalyseJobDependencies,
      };
    };

    it("stops after opening the repository, before asking for the commit", async () => {
      const { controller, github, dependencies } = abortedAfter("open");
      const failure = await failureOf(run(dependencies, [PLAN, controller.signal]));
      expect(failure).toMatchObject({ code: "lease_lost", retryable: false });
      expect(github.calls.commitIds).toEqual([]);
    });

    it("stops after the commit, before the analysis", async () => {
      const controller = new AbortController();
      const analyse = vi.fn();
      const github = fakeGitHub({
        getCommitId: () => {
          controller.abort();
          return Promise.resolve(COMMIT);
        },
      });
      const failure = await failureOf(
        run({ openRepository: github.openRepository, analyse }, [PLAN, controller.signal]),
      );
      expect(failure.code).toBe("lease_lost");
      expect(analyse).not.toHaveBeenCalled();
    });

    it("gives nothing to store when the lease ran out during the analysis", async () => {
      const { controller, dependencies } = abortedAfter("analyse");
      const failure = await failureOf(run(dependencies, [PLAN, controller.signal]));
      expect(failure.code).toBe("lease_lost");
    });
  });

  describe("what goes wrong in each step is recorded as a code", () => {
    const analyseNothing = vi.fn();

    it("when GitHub cannot open the repository or does not know the ref", async () => {
      const opening = await failureOf(
        run({
          openRepository: () => Promise.reject(new GitHubError("request_failed", 404)),
          analyse: analyseNothing,
        }),
      );
      expect(opening).toMatchObject({ code: "repository_or_ref_not_found", retryable: false });
      const github = fakeGitHub({
        getCommitId: () => Promise.reject(new GitHubError("request_failed", 422)),
      });
      const looking = await failureOf(
        run({ openRepository: github.openRepository, analyse: analyseNothing }),
      );
      expect(looking).toMatchObject({ code: "repository_or_ref_not_found", retryable: false });
    });

    it("when the download or the analysis fails", async () => {
      const github = fakeGitHub();
      const downloading = await failureOf(
        run({
          openRepository: github.openRepository,
          analyse: () => Promise.reject(new GitHubError("timed_out")),
        }),
      );
      expect(downloading).toMatchObject({ code: "github_unavailable", retryable: true });
      const analysing = await failureOf(
        run({
          openRepository: github.openRepository,
          analyse: () => Promise.reject(new AnalysisError("repository_too_large")),
        }),
      );
      expect(analysing).toMatchObject({ code: "repository_too_large", retryable: false });
    });

    it("and anything else is left as it was thrown, for the worker to record without its message", async () => {
      const github = fakeGitHub();
      const unknown = new Error("a path of the customer's: /srv/x/.env");
      await expect(
        run({ openRepository: github.openRepository, analyse: () => Promise.reject(unknown) }),
      ).rejects.toBe(unknown);
    });
  });
});

describe("githubRepositories", () => {
  it("asks for a token for the one repository, and reads with it", async () => {
    const token = { token: "t" };
    const reader = fakeGitHub();
    const readerOf = await reader.openRepository(1, "x");
    const app = {
      createInstallationToken: vi.fn(() => Promise.resolve(token)),
      forInstallation: vi.fn(() => readerOf),
    };
    const open = githubRepositories(app as never);
    expect(await open(11, "shop")).toBe(readerOf);
    expect(app.createInstallationToken).toHaveBeenCalledWith(11, "shop");
    expect(app.forInstallation).toHaveBeenCalledWith(token);
  });

  it("lets a failure to get a token through as it is", async () => {
    const error = new GitHubError("request_failed", 401);
    const open = githubRepositories({
      createInstallationToken: () => Promise.reject(error),
      forInstallation: () => {
        throw new Error("not reached");
      },
    });
    await expect(open(11, "shop")).rejects.toBe(error);
  });
});
