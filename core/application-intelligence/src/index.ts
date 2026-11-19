/**
 * What the host knows of repository analysis: the shape of the answer and how to check it, and how
 * to have it made in the sandbox. The analyser itself is in `./analyser` and runs only inside the
 * sandbox (invariant 8): nothing here imports it.
 */
export { analyseArchive, type AnalyseArchiveOptions, type ArchiveSink } from "./archive.js";
export * from "./constants.js";
export { AnalysisError, type AnalysisErrorCode } from "./errors.js";
export {
  ANALYSIS_SANDBOX,
  analyseInSandbox,
  type AnalyseInSandboxOptions,
  type AnalysisPolicyLimits,
} from "./run.js";
export {
  STAGING_LIMITS,
  stageAnalysis,
  type Staged,
  type StageOptions,
  type StagingLimits,
} from "./stage.js";
export {
  FactsRejected,
  parseRepositoryFacts,
  repositoryFactsSchema,
  repositoryPath,
  type DependencyFact,
  type EnvVarFact,
  type FileFact,
  type FrameworkFact,
  type ImportFact,
  type Language,
  type PackageFact,
  type RepositoryFacts,
  type Role,
  type RouteFact,
} from "./facts.js";
