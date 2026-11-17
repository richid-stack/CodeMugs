import { createHash } from "node:crypto";
import { Secret } from "@codemugs/configuration";
import { z } from "zod";
import { GitHubError } from "./errors.js";
import { createAppJwt } from "./jwt.js";
import { Transport, type TransportOptions } from "./transport.js";

export type Permissions = Readonly<Record<string, string>>;

const permissions = z.record(z.string(), z.string());

const appSchema = z.object({
  id: z.number().int().positive(),
  client_id: z.string().optional(),
  slug: z.string().optional(),
  name: z.string(),
  permissions,
  events: z.array(z.string()),
});

const installationSchema = z.object({
  id: z.number().int().positive(),
  app_id: z.number().int().positive(),
  account: z.object({ login: z.string(), type: z.string() }).nullable(),
  repository_selection: z.enum(["all", "selected"]),
  permissions,
  suspended_at: z.string().nullable(),
});

const tokenSchema = z.object({
  // Tokens are not of a length that is promised, so only that it is printable, not empty (the pattern wants one character) and not unreasonable.
  token: z
    .string()
    .max(4096)
    .regex(/^[\x21-\x7e]+$/),
  expires_at: z.string(),
  permissions,
  repository_selection: z.enum(["all", "selected"]),
  repositories: z.array(z.object({ name: z.string() })).optional(),
});

const repositorySchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string().min(1),
});

const commitSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/) });

export interface AppInfo {
  readonly id: number;
  readonly clientId: string | undefined;
  readonly name: string;
  readonly permissions: Permissions;
  readonly events: readonly string[];
}

export interface InstallationInfo {
  readonly id: number;
  readonly appId: number;
  readonly account: { readonly login: string; readonly type: string } | null;
  readonly repositorySelection: "all" | "selected";
  readonly permissions: Permissions;
  readonly suspended: boolean;
}

export interface InstallationToken {
  /** A credential that lasts an hour at most. It is a {@link Secret}, so it cannot be printed by accident. */
  readonly token: Secret;
  readonly expiresAt: Date;
  /** What GitHub says the token may do, which is not always what was asked. */
  readonly permissions: Permissions;
  readonly repositorySelection: "all" | "selected";
  readonly repositories: readonly string[];
}

export interface RepositoryInfo {
  readonly id: number;
  readonly name: string;
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string;
}

export interface DownloadOptions {
  /** The most bytes that may be downloaded. A download of more is stopped and refused. */
  readonly maxBytes: number;
  /** Receives the bytes as they arrive, in order. If it throws, the download stops with `sink_failed`. */
  readonly onChunk?: (chunk: Uint8Array) => void | Promise<void>;
}

export interface DownloadResult {
  readonly bytes: number;
  readonly sha256: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;

function owner(value: string): string {
  if (typeof value !== "string" || !OWNER.test(value)) throw new GitHubError("invalid_input");
  return value;
}

function repository(value: string): string {
  if (typeof value !== "string" || !REPOSITORY.test(value) || value === "." || value === "..") {
    throw new GitHubError("invalid_input");
  }
  return value;
}

/** What Git does not allow in a name: control characters, a space, and `~ ^ : ? * [ \`. */
const hasForbiddenCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character)) return true;
  }
  return false;
};

/**
 * A commit, a branch or a tag, as the path of a request. It must be a name that Git allows for a
 * reference (`git check-ref-format`), which is a good deal wider than letters and digits: a branch
 * may hold `+`, `$`, `#`, `%`, `@` and letters of any script. So that none of these can change
 * the path, each part is percent-encoded (a `%` becomes `%25`, and is never decoded twice), and a
 * part that is empty (which is how an empty reference is refused), hidden (starts with a dot) or
 * ends in `.lock` is refused, with `..`.
 */
function reference(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 255 ||
    hasForbiddenCharacter(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value === "@" ||
    value.endsWith(".")
  ) {
    throw new GitHubError("invalid_input");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part.startsWith(".") || part.endsWith(".lock"))) {
    throw new GitHubError("invalid_input");
  }
  try {
    return parts.map(encodeURIComponent).join("/");
  } catch {
    // A lone surrogate cannot be encoded, and is not a name that anyone gave a branch.
    throw new GitHubError("invalid_input");
  }
}

function id(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new GitHubError("invalid_input");
  return value;
}

export interface GitHubAppOptions extends TransportOptions {
  /** Milliseconds since the epoch. For tests. */
  readonly now?: () => number;
}

/**
 * The app itself: what can be asked with a JWT signed by its key. A new JWT is made for each
 * request and is not kept. Everything that GitHub answers is checked against a schema before any
 * of it is used.
 */
export class GitHubApp {
  readonly #clientId: string;
  readonly #privateKey: Secret;
  readonly #transport: Transport;
  readonly #now: (() => number) | undefined;

  constructor(config: { clientId: string; privateKey: Secret }, options: GitHubAppOptions = {}) {
    this.#clientId = config.clientId;
    this.#privateKey = config.privateKey;
    this.#transport = new Transport(options);
    this.#now = options.now;
  }

  #jwt(): Secret {
    return createAppJwt({
      clientId: this.#clientId,
      privateKey: this.#privateKey,
      ...(this.#now === undefined ? {} : { now: this.#now }),
    });
  }

  /** The app that the key belongs to. */
  async getApp(): Promise<AppInfo> {
    const response = await this.#transport.api("/app", { method: "GET", credential: this.#jwt() });
    const app = await this.#transport.json(response, appSchema);
    return {
      id: app.id,
      clientId: app.client_id,
      name: app.name,
      permissions: app.permissions,
      events: app.events,
    };
  }

  async getInstallation(installationId: number): Promise<InstallationInfo> {
    const response = await this.#transport.api(`/app/installations/${String(id(installationId))}`, {
      method: "GET",
      credential: this.#jwt(),
    });
    const installation = await this.#transport.json(response, installationSchema);
    return {
      id: installation.id,
      appId: installation.app_id,
      account: installation.account,
      repositorySelection: installation.repository_selection,
      permissions: installation.permissions,
      suspended: installation.suspended_at !== null,
    };
  }

  /**
   * The only token that this client can ask for: one repository of the installation, and read
   * access to its contents. A wider token (another repository, another permission, "everything")
   * is not a thing that can be asked for here, so it cannot be asked for by mistake or by a caller
   * that was fed a name. A different token is a different method, added on purpose.
   */
  async createInstallationToken(
    installationId: number,
    repositoryName: string,
  ): Promise<InstallationToken> {
    const response = await this.#transport.api(
      `/app/installations/${String(id(installationId))}/access_tokens`,
      {
        method: "POST",
        credential: this.#jwt(),
        body: { repositories: [repository(repositoryName)], permissions: { contents: "read" } },
      },
    );
    const created = await this.#transport.json(response, tokenSchema);
    const expiresAt = new Date(created.expires_at);
    if (Number.isNaN(expiresAt.getTime())) throw new GitHubError("response_rejected");
    return {
      token: new Secret(created.token),
      expiresAt,
      permissions: created.permissions,
      repositorySelection: created.repository_selection,
      repositories: (created.repositories ?? []).map((entry) => entry.name),
    };
  }

  /** What an installation token can do, for the repositories and the permissions that it has. */
  forInstallation(token: InstallationToken): InstallationClient {
    return new InstallationClient(token.token, this.#transport);
  }
}

/** Reads of a repository, with the token of an installation. It can only do what the token may. */
export class InstallationClient {
  readonly #token: Secret;
  readonly #transport: Transport;

  constructor(token: Secret, transport: Transport) {
    this.#token = token;
    this.#transport = transport;
  }

  async getRepository(ownerName: string, repositoryName: string): Promise<RepositoryInfo> {
    const response = await this.#transport.api(
      `/repos/${owner(ownerName)}/${repository(repositoryName)}`,
      { method: "GET", credential: this.#token },
    );
    const found = await this.#transport.json(response, repositorySchema);
    return {
      id: found.id,
      name: found.name,
      fullName: found.full_name,
      private: found.private,
      defaultBranch: found.default_branch,
    };
  }

  /** The commit that a branch, a tag or a commit id names, as a full commit id. */
  async getCommitId(ownerName: string, repositoryName: string, ref: string): Promise<string> {
    const response = await this.#transport.api(
      `/repos/${owner(ownerName)}/${repository(repositoryName)}/commits/${reference(ref)}`,
      { method: "GET", credential: this.#token },
    );
    return (await this.#transport.json(response, commitSchema)).sha;
  }

  /**
   * Downloads the repository at a commit as a gzipped tar, and hands the bytes on without keeping
   * them. GitHub answers with a redirect to a host that serves the archive, at an address that
   * carries a credential of its own. The token is sent to the API only: the redirect is followed
   * to a host that was allowed, by a request that has none of ours, and anywhere else is refused.
   *
   * What comes back is a customer's repository: bytes, and nothing else, until something that
   * is written to read untrusted archives reads them.
   */
  async downloadTarball(
    ownerName: string,
    repositoryName: string,
    ref: string,
    options: DownloadOptions,
  ): Promise<DownloadResult> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new GitHubError("invalid_input");
    }
    const first = await this.#transport.api(
      `/repos/${owner(ownerName)}/${repository(repositoryName)}/tarball/${reference(ref)}`,
      { method: "GET", credential: this.#token },
    );
    if (![301, 302, 303, 307, 308].includes(first.status)) {
      await this.#transport.success(first);
      throw new GitHubError("response_rejected");
    }
    const location = first.headers.get("location");
    await this.#transport.guard(() => first.body?.cancel() ?? Promise.resolve());
    if (location === null) throw new GitHubError("response_rejected");
    const url = this.#transport.downloadUrl(location);

    const response = await this.#transport.success(await this.#transport.download(url));
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await this.#transport.guard(() => response.body?.cancel() ?? Promise.resolve());
      throw new GitHubError("download_too_large");
    }
    const body = response.body;
    if (body === null) throw new GitHubError("response_rejected");

    const hash = createHash("sha256");
    let bytes = 0;
    await this.#transport.guard(async () => {
      const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > options.maxBytes) {
          await reader.cancel();
          throw new GitHubError("download_too_large");
        }
        hash.update(value);
        if (options.onChunk !== undefined) {
          try {
            await options.onChunk(value);
          } catch {
            await reader.cancel();
            throw new GitHubError("sink_failed");
          }
        }
      }
    });
    return { bytes, sha256: hash.digest("hex") };
  }

  /**
   * The status of an attempt to write, which a read-only token must be refused. The attempt has no
   * content, so that if it were allowed it would be refused as invalid and create nothing: GitHub
   * checks the permission before it looks at the body. 403 or 404 is a refusal for lack of rights.
   */
  async probeWrite(ownerName: string, repositoryName: string): Promise<number> {
    const response = await this.#transport.api(
      `/repos/${owner(ownerName)}/${repository(repositoryName)}/git/blobs`,
      { method: "POST", credential: this.#token, body: {} },
    );
    await this.#transport.guard(() => response.body?.cancel() ?? Promise.resolve());
    return response.status;
  }
}
