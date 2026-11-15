/**
 * The analyser, which reads customer code and so runs only inside a sandbox (invariant 8). It has
 * an entry of its own so that the host's entry, `index.ts`, does not carry it: the host calls the
 * sandbox and reads the answer, and never imports a function that opens a customer's file.
 */
export { analyse, type AnalyseOptions } from "./analyse.js";
export { directorySource, memorySource, type AnalysisSource, type SourceFile } from "./source.js";
