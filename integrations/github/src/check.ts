import { tmpdir } from "node:os";
import { GitHubApp, type GitHubAppOptions, type Permissions } from "./client.js";
import type { GitHubAppConfig } from "./config.js";
import { GitHubError } from "./errors.js";
import { startUnpacking } from "./unpack.js";

/** The most that the check downloads (this repository is a few hundred kilobytes). */
const CHECK_MAX_BYTES = 64 * 1024 * 1024;
const UNPACK = "the download can be unpacked";
/** A token lasts an hour: more than a little over is not a token of GitHub's. */
const MAX_TOKEN_LIFETIME_MS = 65 * 60 * 1000;

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  /** Only what is safe to print: names, numbers and short words, never a key, a token or a link. */
  readonly detail: string;
}

export interface CheckReport {
  readonly results: readonly CheckResult[];
  readonly ok: boolean;
}

export interface CheckOptions extends GitHubAppOptions {
  readonly config: GitHubAppConfig;
  /** The repository to read, which is the only one that the token is asked for. */
  readonly owner: string;
  readonly repository: string;
  /** The most that the check downloads. The default is far more than this repository. */
  readonly maxDownloadBytes?: number;
  /** Where the download is unpacked, in a directory that is made and removed. The default is the system's. */
  readonly unpackRoot?: string;
}

/**
 * True when a set of permissions lets the holder read the contents of a repository and grants
 * nothing else, apart from reading its metadata, which GitHub gives to every app and token.
 */
export const readsContentsOnly = (actual: Permissions): boolean =>
  actual["contents"] === "read" &&
  Object.entries(actual).every(
    ([name, level]) => name === "contents" || (name === "metadata" && level === "read"),
  );

const list = (permissions: Permissions): string =>
  Object.entries(permissions)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, level]) => `${name}:${level}`)
    .join(",") || "none";

/** A failure as a short thing to print: the code and the status, which are all that an error holds. */
function why(error: unknown): string {
  if (error instanceof GitHubError) {
    return error.status === undefined ? error.code : `${error.code} (HTTP ${String(error.status)})`;
  }
  return "unexpected_error";
}

/**
 * Checks, against GitHub itself, that the app is the one that was meant, that it can do exactly
 * what was meant and no more, and that a token narrowed to one repository can read it and cannot
 * write to it. Nothing that it prints is secret. It reads, and downloads the repository once to
 * count the bytes and to unpack it into a directory that it removes; it changes nothing on GitHub.
 */
export async function runCheck(options: CheckOptions): Promise<CheckReport> {
  const { config, owner, repository, maxDownloadBytes, unpackRoot, ...appOptions } = options;
  const results: CheckResult[] = [];
  const record = (name: string, ok: boolean, detail: string): boolean => {
    results.push({ name, ok, detail });
    return ok;
  };
  const attempt = async <T>(name: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work();
    } catch (error) {
      record(name, false, why(error));
      return undefined;
    }
  };

  const app = new GitHubApp(
    { clientId: config.clientId, privateKey: config.privateKey },
    appOptions,
  );

  // 1. The key signs, and GitHub accepts it as the app's.
  const info = await attempt("the key signs in as the app", () => app.getApp());
  if (info !== undefined) {
    record("the key signs in as the app", true, `app ${String(info.id)}`);
    record(
      "it is the app that was meant",
      info.id === config.appId &&
        (info.clientId === undefined || info.clientId === config.clientId),
      `app id ${info.id === config.appId ? "matches" : "does not match"}, client id ${info.clientId === undefined ? "not shown" : info.clientId === config.clientId ? "matches" : "does not match"}`,
    );
    record(
      "the app can only read contents",
      readsContentsOnly(info.permissions),
      `permissions ${list(info.permissions)}`,
    );
    record(
      "the app has no webhook events",
      info.events.length === 0,
      `${String(info.events.length)} events`,
    );
  }

  // 2. The installation is on this account, on chosen repositories, and not suspended.
  const installation =
    info === undefined
      ? undefined
      : await attempt("the app is installed", () => app.getInstallation(config.installationId));
  if (installation !== undefined) {
    record(
      "the app is installed",
      installation.appId === config.appId,
      `installation ${String(installation.id)} of app ${String(installation.appId)}`,
    );
    record(
      "it is installed for this owner only",
      installation.account?.login.toLowerCase() === owner.toLowerCase(),
      `account ${installation.account?.login ?? "none"} (${installation.account?.type ?? "none"})`,
    );
    record(
      "it is installed on chosen repositories, not all",
      installation.repositorySelection === "selected",
      `repository_selection ${installation.repositorySelection}`,
    );
    record(
      "the installation can only read contents",
      readsContentsOnly(installation.permissions),
      `permissions ${list(installation.permissions)}`,
    );
    record(
      "the installation is not suspended",
      !installation.suspended,
      installation.suspended ? "suspended" : "active",
    );
  }

  // 3. A token narrowed to one repository, with the one permission that is needed.
  const token =
    installation === undefined
      ? undefined
      : await attempt("a token can be made", () =>
          app.createInstallationToken(config.installationId, repository),
        );
  if (token === undefined) return finish(results);
  const remaining = token.expiresAt.getTime() - (appOptions.now?.() ?? Date.now());
  record(
    "a token can be made",
    remaining > 0 && remaining <= MAX_TOKEN_LIFETIME_MS,
    `lasts ${String(Math.round(remaining / 60000))} minutes`,
  );
  record(
    "the token is for one repository",
    token.repositorySelection === "selected" &&
      token.repositories.length === 1 &&
      token.repositories[0] === repository,
    `${token.repositorySelection}, ${String(token.repositories.length)} repository`,
  );
  record(
    "the token can only read contents",
    readsContentsOnly(token.permissions),
    `permissions ${list(token.permissions)}`,
  );

  // 4. What it can do with the token: read, and not write.
  const reader = app.forInstallation(token);
  const found = await attempt("the repository can be read", () =>
    reader.getRepository(owner, repository),
  );
  if (found !== undefined)
    record(
      "the repository can be read",
      found.name === repository,
      `${found.fullName}, ${found.private ? "private" : "public"}, default branch ${found.defaultBranch}`,
    );
  const commit =
    found === undefined
      ? undefined
      : await attempt("the latest commit can be read", () =>
          reader.getCommitId(owner, repository, found.defaultBranch),
        );
  if (commit !== undefined) record("the latest commit can be read", true, commit.slice(0, 12));
  // The archive is unpacked as it arrives, so that it is an archive that GitHub made that the
  // reader of ADR 0028 is shown, and not only one that a test wrote.
  const unpacking =
    commit === undefined
      ? undefined
      : await attempt(UNPACK, () => startUnpacking(unpackRoot ?? tmpdir()));
  const download =
    commit === undefined
      ? undefined
      : await attempt("the repository can be downloaded", () =>
          reader.downloadTarball(owner, repository, commit, {
            maxBytes: maxDownloadBytes ?? CHECK_MAX_BYTES,
            ...(unpacking === undefined ? {} : { onChunk: (chunk) => unpacking.sink(chunk) }),
          }),
        );
  if (download !== undefined)
    record(
      "the repository can be downloaded",
      download.bytes > 0,
      `${String(download.bytes)} bytes, sha256 ${download.sha256.slice(0, 12)}`,
    );
  const unpacked = await unpacking?.end(download !== undefined);
  if (unpacked !== undefined) record(UNPACK, unpacked.ok, unpacked.detail);
  const refused = await attempt("a write is refused", () => reader.probeWrite(owner, repository));
  if (refused !== undefined)
    record("a write is refused", refused === 403 || refused === 404, `HTTP ${String(refused)}`);

  return finish(results);
}

function finish(results: readonly CheckResult[]): CheckReport {
  return { results, ok: results.every((result) => result.ok) };
}

/** The report as lines of text. */
export function formatReport(report: CheckReport): string {
  const lines = report.results.map(
    (result) => `${result.ok ? "ok  " : "FAIL"}  ${result.name}: ${result.detail}`,
  );
  lines.push(report.ok ? "All checks passed." : "Some checks failed.");
  return lines.join("\n");
}
