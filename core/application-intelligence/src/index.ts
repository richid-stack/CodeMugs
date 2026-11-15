/**
 * What the host knows of repository analysis: the shape of the answer and how to check it. The
 * analyser itself is in `./analyser` and runs only inside the sandbox (invariant 8).
 */
export * from "./constants.js";
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
