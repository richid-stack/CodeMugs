/** The kind of the job that analyses a repository. The worker that does it registers this kind. */
export const ANALYSE_JOB_KIND = "repository.analyse";

/**
 * How many times the job may be tried. An analysis that failed for a reason that a retry cannot
 * mend (a repository that is too large, a ref that is not there) says so with a code and is not
 * retried; this is for the ones that can be mended, a download that was cut off or a sandbox that
 * was busy.
 */
export const ANALYSE_JOB_ATTEMPTS = 3;
