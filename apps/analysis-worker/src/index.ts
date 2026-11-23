/**
 * The job that analyses a repository, for the worker process that holds the credentials for it
 * (ADR 0031, ADR 0014). It is not for the API: the API only records and enqueues.
 */
export {
  analyseJob,
  analysisHandlers,
  githubRepositories,
  type AnalyseJobDependencies,
  type RepositoryReader,
} from "./analyse-job.js";
export { failureOf } from "./failure.js";
// The process, for the test of the whole path (`tests/end-to-end`), which starts it in its own
// process with a stand-in for GitHub. The program itself is `main.ts`.
export { loadAnalysisWorkerConfig, type AnalysisWorkerConfig } from "./config.js";
export { startAnalysisWorker, type StartOptions } from "./start.js";
