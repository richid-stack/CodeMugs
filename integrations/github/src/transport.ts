import type { Secret } from "@codemugs/configuration";
import type { z } from "zod";
import { GitHubError } from "./errors.js";

export const DEFAULT_API_URL = "https://api.github.com";
export const DEFAULT_API_VERSION = "2026-03-10";
export const DEFAULT_DOWNLOAD_HOSTS: readonly string[] = ["codeload.github.com"];

const MAX_JSON_BYTES = 1_048_576;
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

export interface TransportOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Where the API is. Must be https, or http on this machine (for tests); GitHub's own by default. */
  readonly apiBaseUrl?: string;
  readonly apiVersion?: string;
  /** How long one request may take, for the API. */
  readonly timeoutMs?: number;
  /** How long a download may take. */
  readonly downloadTimeoutMs?: number;
  /** The only hosts that a download may be sent to. */
  readonly downloadHosts?: readonly string[];
}

export interface RequestInit {
  readonly method: "GET" | "POST";
  /** The credential for this request: a JWT of the app, or the token of an installation. */
  readonly credential: Secret;
  readonly body?: unknown;
}

/** An address that is safe to send a request to: https, or http to this very machine. No login, no query. */
function checkedUrl(text: string, allowQuery: boolean): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new GitHubError("invalid_input");
  }
  const local = LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new GitHubError("invalid_input");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new GitHubError("invalid_input");
  }
  if (!allowQuery && url.search !== "") throw new GitHubError("invalid_input");
  return url;
}

/** What goes between the code and the network: the headers, the time limits and the checks on what comes back. */
export class Transport {
  readonly #fetch: typeof globalThis.fetch;
  readonly #base: string;
  readonly #version: string;
  readonly #timeoutMs: number;
  readonly #downloadTimeoutMs: number;
  readonly #downloadHosts: ReadonlySet<string>;

  constructor(options: TransportOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = checkedUrl(options.apiBaseUrl ?? DEFAULT_API_URL, false).href.replace(/\/$/, "");
    this.#version = options.apiVersion ?? DEFAULT_API_VERSION;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#downloadTimeoutMs = options.downloadTimeoutMs ?? 120_000;
    this.#downloadHosts = new Set(
      (options.downloadHosts ?? DEFAULT_DOWNLOAD_HOSTS).map((host) => host.toLowerCase()),
    );
  }

  /** Runs a call that talks to the network, and turns what goes wrong into one of our errors. */
  async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      const name = (error as { name?: unknown } | null)?.name;
      throw new GitHubError(
        name === "TimeoutError" || name === "AbortError" ? "timed_out" : "request_failed",
      );
    }
  }

  /** A request to the API. Redirects are not followed here: the caller says what one means. */
  async api(path: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${init.credential.reveal()}`,
      "User-Agent": "codemugs",
      "X-GitHub-Api-Version": this.#version,
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    return this.guard(() =>
      this.#fetch(`${this.#base}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? null : JSON.stringify(init.body),
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      }),
    );
  }

  /** The body of an answer, read at most up to a limit, as untrusted text. */
  async text(response: Response, maxBytes: number = MAX_JSON_BYTES): Promise<string> {
    return this.guard(async () => {
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel();
        throw new GitHubError("response_rejected");
      }
      if (response.body === null) return "";
      const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new GitHubError("response_rejected");
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString("utf8");
    });
  }

  /** Throws for an answer that is not a success, and gives the success back. The body is never read. */
  async success(response: Response): Promise<Response> {
    if (response.status >= 200 && response.status < 300) return response;
    await this.guard(() => response.body?.cancel() ?? Promise.resolve());
    throw new GitHubError("request_failed", response.status);
  }

  /** A JSON answer, checked against a schema: what GitHub says is data, and nothing is used before it is checked. */
  async json<S extends z.ZodType>(response: Response, schema: S): Promise<z.output<S>> {
    const text = await this.text(await this.success(response));
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new GitHubError("response_rejected");
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new GitHubError("response_rejected");
    return parsed.data;
  }

  /**
   * Where a download may go: https (or this machine, for tests), a host that was allowed, no login
   * in the address, and the port of the scheme. The address carries a credential of its own, so
   * it is never put in an error.
   */
  downloadUrl(location: string): URL {
    let url: URL;
    try {
      url = checkedUrl(location, true);
    } catch {
      throw new GitHubError("redirect_refused");
    }
    const local = LOOPBACK.has(url.hostname);
    if (!this.#downloadHosts.has(url.hostname) || (url.port !== "" && !local)) {
      throw new GitHubError("redirect_refused");
    }
    return url;
  }

  /** A download, with no credential of ours: it is sent to a host that is not the API. */
  async download(url: URL): Promise<Response> {
    return this.guard(() =>
      this.#fetch(url, {
        method: "GET",
        headers: { "User-Agent": "codemugs" },
        redirect: "error",
        signal: AbortSignal.timeout(this.#downloadTimeoutMs),
      }),
    );
  }
}
