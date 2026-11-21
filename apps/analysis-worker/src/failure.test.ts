import { AnalysisError, type AnalysisErrorCode } from "@codemugs/application-intelligence";
import { GitHubError, type GitHubErrorCode } from "@codemugs/github";
import { JobFailure } from "@codemugs/jobs";
import { GraphError, type GraphErrorCode } from "@codemugs/system-graph";
import { describe, expect, it } from "vitest";
import { failureOf } from "./failure.js";

const failure = (error: unknown): { code: string; retryable: boolean } | undefined => {
  const result = failureOf(error);
  return result === undefined ? undefined : { code: result.code, retryable: result.retryable };
};

describe("what an analysis that did not give a graph is recorded as", () => {
  it("keeps a failure of the job as it is", () => {
    const own = new JobFailure("request_not_found", { retryable: false });
    expect(failureOf(own)).toBe(own);
  });

  it.each<[string, number | undefined, string, boolean]>([
    ["a repository that is not there", 404, "repository_or_ref_not_found", false],
    ["a ref that names no commit", 422, "repository_or_ref_not_found", false],
    ["a token that is refused", 401, "github_access_denied", true],
    ["a refusal that may be a rate limit", 403, "github_access_denied", true],
    ["a request that GitHub does not accept", 400, "github_rejected", false],
    ["a request that GitHub says is too many", 429, "github_unavailable", true],
    ["an error of GitHub's", 502, "github_unavailable", true],
    ["no answer at all", undefined, "github_unavailable", true],
  ])("%s (status %s) is %s", (_label, status, code, retryable) => {
    expect(failure(new GitHubError("request_failed", status))).toEqual({ code, retryable });
  });

  it.each<[GitHubErrorCode, string, boolean]>([
    ["timed_out", "github_unavailable", true],
    ["download_too_large", "repository_too_large", false],
    ["invalid_input", "request_invalid", false],
    ["key_invalid", "github_not_configured", true],
    ["redirect_refused", "github_redirect_refused", false],
    ["response_rejected", "github_response_rejected", true],
    ["sink_failed", "github_response_rejected", true],
    ["request_failed", "github_unavailable", true],
  ])("a GitHub error of %s is %s", (code, recorded, retryable) => {
    expect(failure(new GitHubError(code))).toEqual({ code: recorded, retryable });
  });

  it.each<[AnalysisErrorCode, boolean]>([
    ["sandbox_unavailable", true],
    ["sandbox_too_weak", false],
    ["sandbox_failed", true],
    ["repository_unreadable", false],
    ["repository_too_large", false],
    ["analysis_failed", true],
    ["analysis_timed_out", false],
    ["analysis_out_of_memory", false],
    ["analysis_output_too_large", false],
    ["analysis_output_rejected", false],
    ["cleanup_failed", true],
  ])("an analysis error of %s keeps its code, and is retried: %s", (code, retryable) => {
    expect(failure(new AnalysisError(code))).toEqual({ code, retryable });
  });

  it.each<GraphErrorCode>(["invalid_input", "facts_rejected", "project_not_found", "run_conflict"])(
    "a graph error of %s is not tried again",
    (code) => {
      expect(failure(new GraphError(code))).toEqual({ code: `graph_${code}`, retryable: false });
    },
  );

  it("leaves anything else alone, so that the worker records it without its message", () => {
    expect(failureOf(new Error("secret path /srv/customer/.env"))).toBeUndefined();
    expect(failureOf("text")).toBeUndefined();
    expect(failureOf(undefined)).toBeUndefined();
  });

  it("gives codes that the queue accepts as they are", () => {
    const all = [
      ...(
        [
          "request_failed",
          "timed_out",
          "download_too_large",
          "invalid_input",
          "key_invalid",
        ] as const
      ).map((code) => failureOf(new GitHubError(code, 500))!),
      failureOf(new GitHubError("request_failed", 404))!,
      failureOf(new GraphError("run_conflict"))!,
    ];
    for (const result of all) expect(result.code).toMatch(/^[a-z][a-z0-9_.-]{0,63}$/);
  });

  it("never puts a message of the error in the failure", () => {
    const result = failureOf(new GitHubError("request_failed", 404));
    expect(result?.message).toBe("job failed: repository_or_ref_not_found");
  });
});
