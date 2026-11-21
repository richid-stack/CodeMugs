/**
 * Which repository a project is, and the requests to analyse it. This is the side of the analysis
 * that the API uses: it reads and writes rows and enqueues a job, and it holds no credential for
 * GitHub and has no way to run anything. The job is done by a worker of its own (ADR 0031).
 */
export { ANALYSE_JOB_ATTEMPTS, ANALYSE_JOB_KIND } from "./constants.js";
export {
  connectRepository,
  getConnection,
  type ConnectRepositoryInput,
  type RepositoryConnection,
} from "./connect.js";
export { RepositoryAnalysisError, type RepositoryAnalysisErrorCode } from "./errors.js";
export {
  readAnalysisPlan,
  requestAnalysis,
  type AnalysisPlan,
  type RequestAnalysisInput,
} from "./request.js";
export {
  DEFAULT_LIST_LIMIT,
  getAnalysis,
  listAnalyses,
  MAX_LIST_LIMIT,
  type AnalysisState,
  type AnalysisStatus,
} from "./status.js";
