import { pathToFileURL } from "node:url";
import { ConfigError } from "@codemugs/configuration";
import { formatReport, runCheck } from "./check.js";
import { loadGitHubAppConfig } from "./config.js";
import { GitHubError } from "./errors.js";

const REPOSITORY = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;

export interface MainIo {
  readonly env: Record<string, string | undefined>;
  readonly write: (line: string) => void;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiBaseUrl?: string;
  readonly downloadHosts?: readonly string[];
}

/**
 * `node dist/main.js`: checks the GitHub App against GitHub and prints what it found. The
 * repository is the one that the workflow runs in (`GITHUB_REPOSITORY`). Returns the exit code:
 * 0 when every check passed, 1 when one did not, 2 when it could not start. Nothing it prints is
 * secret, and a configuration error names the variable and never its value.
 */
export async function main(io: MainIo): Promise<number> {
  let config;
  try {
    config = loadGitHubAppConfig(io.env);
  } catch (error) {
    io.write(error instanceof ConfigError ? error.message : "The configuration could not be read.");
    return 2;
  }
  const match = REPOSITORY.exec(io.env["GITHUB_REPOSITORY"] ?? "");
  if (match === null) {
    io.write("GITHUB_REPOSITORY must be owner/name.");
    return 2;
  }
  let report;
  try {
    report = await runCheck({
      config,
      owner: match[1] ?? "",
      repository: match[2] ?? "",
      ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
      ...(io.apiBaseUrl === undefined ? {} : { apiBaseUrl: io.apiBaseUrl }),
      ...(io.downloadHosts === undefined ? {} : { downloadHosts: io.downloadHosts }),
    });
  } catch (error) {
    // A fixed sentence: what went wrong outside the checks, never what was sent or received.
    io.write(error instanceof GitHubError ? error.message : "The check could not run.");
    return 2;
  }
  io.write(formatReport(report));
  return report.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main({ env: process.env, write: (line) => console.log(line) }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.log("The check failed in a way that it cannot describe.");
      process.exitCode = 2;
    },
  );
}
