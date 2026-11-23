import { loadAnalysisWorkerConfig, type AnalysisWorkerConfig } from "./config.js";

/** The variables that hold a secret: the GitHub App's key and the addresses of the database, which carry a password. */
export const SECRET_VARIABLES: readonly string[] = Object.freeze([
  "CODEMUGS_GITHUB_APP_PRIVATE_KEY",
  "DATABASE_URL",
  "DISPATCHER_DATABASE_URL",
]);

/**
 * Removes the variables that hold a secret from an environment, once the settings have been read
 * from it. It changes `env` and returns the names that it removed, which are not secret.
 */
export function forgetSecrets(env: Record<string, string | undefined>): readonly string[] {
  const removed: string[] = [];
  for (const name of SECRET_VARIABLES) {
    if (name in env) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

/**
 * The settings of the process from its environment, and then the secrets are gone from the
 * environment. They are held as secrets in what this returns, and the variables are not needed
 * again: an environment that holds the GitHub key and the database addresses is one that anything
 * this process starts, or any report of its state, would carry along. The environment is left as it
 * was when the settings are refused, so that the refusal can be mended and tried again.
 */
export function takeConfig(
  env: Record<string, string | undefined> = process.env,
): AnalysisWorkerConfig {
  const config = loadAnalysisWorkerConfig(env);
  forgetSecrets(env);
  return config;
}
