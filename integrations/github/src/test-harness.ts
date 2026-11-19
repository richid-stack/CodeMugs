import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { tarball } from "@codemugs/archive/testing";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Secret } from "@codemugs/configuration";

// Everything here is made up for tests. No real key, token or identifier is used, and the key
// pairs are made when the tests run, so that none is ever in the repository.

export const APP_ID = 4242;
export const CLIENT_ID = "IvTestClientId000001";
export const INSTALLATION_ID = 7001;
export const OWNER = "acme-owner";
export const REPOSITORY = "widgets";
/**
 * A made-up value shaped like a client secret (40 characters), for the tests that a client secret
 * pasted where the private key goes is refused. It is not a secret. It is built and not written
 * out, so that a scanner of source does not take it for one.
 */
export const FAKE_CLIENT_SECRET = "0123456789".repeat(4);
/**
 * A repository's archive the way GitHub makes one: gzip, every path under one top directory named
 * after the repository and the commit. It is what the fake serves unless a test says otherwise, so
 * that what the check unpacks is a real archive.
 */
export function repositoryArchive(): Buffer {
  const top = `${OWNER}-${REPOSITORY}-0123abc`;
  return tarball([
    { name: `${top}/README.md`, content: "# widgets\n" },
    { name: `${top}/src/index.ts`, content: "export const widgets = 1;\n" },
  ]);
}

export const COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const INSTALLATION_TOKEN = "fake-installation-token-for-tests-only";
export const DOWNLOAD_CREDENTIAL = "fake-credential-that-the-download-address-carries";
/** Text that an error body would echo; it must never come back out of an error of ours. */
export const BODY_SENTINEL = "SENTINEL-FROM-A-RESPONSE-BODY";

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

let keys: { readonly privatePem: string; readonly publicPem: string } | undefined;

/** An RSA key pair of 2,048 bits, in the form that GitHub gives (PKCS#1), made once. */
export function testKeys(): { readonly privatePem: string; readonly publicPem: string } {
  keys ??= pair(2048);
  return keys;
}

function pair(bits: number): { readonly privatePem: string; readonly publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  return {
    privatePem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** A second pair, that is not the app's, for a key that GitHub does not know. */
export const otherKeys = (): { readonly privatePem: string; readonly publicPem: string } =>
  pair(2048);

export const smallRsaKeyPem = (): string => pair(1024).privatePem;

export const ecKeyPem = (): string =>
  generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();

export const rsaPssKeyPem = (): string =>
  generateKeyPairSync("rsa-pss", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();

export const pkcs8KeyPem = (): string => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
};

export const secretOf = (value: string): Secret => new Secret(value);

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  /** For a request that carried a JWT of the app: what it claimed, once its signature was checked. */
  readonly claims?: Readonly<Record<string, unknown>>;
}

/** What the fake says, changed by a test to make GitHub say something else. */
export interface FakeConfig {
  /** The public half of the key that the app is known by. */
  publicPem: string;
  app: Record<string, unknown>;
  installation: Record<string, unknown>;
  /** Permissions that the token has, when they are not what was asked for (plus metadata). */
  tokenPermissions: Record<string, string> | undefined;
  tokenSelection: "all" | "selected";
  /** Repositories that the token is for, when they are not what was asked for. */
  tokenRepositories: string[] | undefined;
  tokenLifetimeSeconds: number;
  tokenValue: string;
  repository: Record<string, unknown>;
  tarball: Buffer;
  /** Status of the tarball route of the API: a redirect, unless a test says otherwise. */
  tarballStatus: number;
  /** Where the redirect goes, when it is not the download route of this fake. */
  tarballLocation: ((base: string) => string | undefined) | undefined;
  downloadStatus: number;
  sendContentLength: boolean;
  chunkSize: number;
  blobStatus: number;
  /** Status for a route, which then answers with a body that echoes what a real one might. */
  failRoutes: Record<string, number>;
  /** A route that answers after this many milliseconds. */
  delayMs: number;
  /** A body to answer a route with, in place of the JSON that it would give. */
  rawBodies: Record<string, string>;
}

export interface FakeGitHub {
  /** Where the API is. */
  readonly url: string;
  readonly config: FakeConfig;
  readonly requests: RecordedRequest[];
  /** The requests that reached the download route, which is the host that is not the API. */
  readonly downloads: () => RecordedRequest[];
  readonly close: () => Promise<void>;
}

function defaults(): FakeConfig {
  return {
    publicPem: testKeys().publicPem,
    app: {
      id: APP_ID,
      client_id: CLIENT_ID,
      slug: "codemugs-reader-test",
      name: "CodeMugs Reader Test",
      permissions: { contents: "read", metadata: "read" },
      events: [],
    },
    installation: {
      id: INSTALLATION_ID,
      app_id: APP_ID,
      account: { login: OWNER, type: "User" },
      repository_selection: "selected",
      permissions: { contents: "read", metadata: "read" },
      suspended_at: null,
    },
    tokenPermissions: undefined,
    tokenSelection: "selected",
    tokenRepositories: undefined,
    tokenLifetimeSeconds: 3600,
    tokenValue: INSTALLATION_TOKEN,
    repository: {
      id: 99,
      name: REPOSITORY,
      full_name: `${OWNER}/${REPOSITORY}`,
      private: false,
      default_branch: "main",
    },
    tarball: repositoryArchive(),
    tarballStatus: 302,
    tarballLocation: undefined,
    downloadStatus: 200,
    sendContentLength: true,
    chunkSize: 1024,
    blobStatus: 403,
    failRoutes: {},
    delayMs: 0,
    rawBodies: {},
  };
}

const lower = (headers: IncomingMessage["headers"]): Record<string, string | undefined> => {
  const result: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = Array.isArray(value) ? value.join(",") : value;
  }
  return result;
};

/** The claims of a JWT, if it is signed by the key and says what GitHub requires of it. */
function checkedClaims(token: string, publicPem: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [header, payload, signature] = parts as [string, string, string];
  try {
    const head = JSON.parse(Buffer.from(header, "base64url").toString()) as { alg?: unknown };
    if (head.alg !== "RS256") return undefined;
    const signed = verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      createPublicKey(publicPem),
      Buffer.from(signature, "base64url"),
    );
    if (!signed) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
      string,
      unknown
    >;
    const now = Math.floor(Date.now() / 1000);
    const { iat, exp, iss } = claims;
    if (typeof iat !== "number" || typeof exp !== "number") return undefined;
    // GitHub: issued no later than now, and expires within ten minutes of now.
    if (iss !== CLIENT_ID || iat > now || exp <= now || exp > now + 600) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

const bearer = (headers: Record<string, string | undefined>): string | undefined => {
  const value = headers["authorization"];
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
};

function reply(response: ServerResponse, status: number, body: string, type = "application/json") {
  response.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  response.end(body);
}

/** A GitHub that is on this machine, for as long as a test needs it. */
export async function startFakeGitHub(overrides: Partial<FakeConfig> = {}): Promise<FakeGitHub> {
  const config: FakeConfig = { ...defaults(), ...overrides };
  const requests: RecordedRequest[] = [];
  let base = "";

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", "http://fake");
    const method = request.method ?? "GET";
    const headers = lower(request.headers);
    const path = url.pathname;
    const credential = bearer(headers);
    const jwt = credential === undefined ? undefined : checkedClaims(credential, config.publicPem);
    requests.push({
      method,
      path: url.pathname + url.search,
      headers,
      body,
      ...(jwt ? { claims: jwt } : {}),
    });

    if (config.delayMs > 0) await new Promise((done) => setTimeout(done, config.delayMs));

    const failure = config.failRoutes[`${method} ${path}`];
    if (failure !== undefined) {
      // An error body that echoes what it was sent, as a real one can.
      return reply(response, failure, JSON.stringify({ message: BODY_SENTINEL, echo: credential }));
    }
    const raw = config.rawBodies[`${method} ${path}`];
    if (raw !== undefined) return reply(response, 200, raw);

    // The download host is not the API: a credential sent to it is a mistake, so it is refused.
    if (path.startsWith("/codeload/")) {
      if (headers["authorization"] !== undefined) return reply(response, 400, "{}");
      if (url.searchParams.get("token") !== DOWNLOAD_CREDENTIAL) return reply(response, 403, "{}");
      if (REDIRECTS.has(config.downloadStatus)) {
        // A second redirect, to a route that records that it was followed.
        response.writeHead(config.downloadStatus, {
          location: `${base}/codeload/second?token=${DOWNLOAD_CREDENTIAL}`,
        });
        response.end();
        return;
      }
      if (config.downloadStatus !== 200) return reply(response, config.downloadStatus, "{}");
      const size = config.tarball.length;
      response.writeHead(200, {
        "content-type": "application/x-gzip",
        ...(config.sendContentLength ? { "content-length": size } : {}),
      });
      for (let at = 0; at < size; at += config.chunkSize) {
        if (!response.write(config.tarball.subarray(at, at + config.chunkSize))) {
          await new Promise((done) => response.once("drain", done));
        }
        if (response.destroyed) return;
      }
      response.end();
      return;
    }

    const unauthorised = () => reply(response, 401, JSON.stringify({ message: "Bad credentials" }));
    const appRoute = /^\/app(\/installations\/(\d+)(\/access_tokens)?)?$/.exec(path);
    if (appRoute !== null) {
      if (jwt === undefined) return unauthorised();
      if (path === "/app" && method === "GET")
        return reply(response, 200, JSON.stringify(config.app));
      if (appRoute[2] === String(INSTALLATION_ID)) {
        if (appRoute[3] === undefined && method === "GET") {
          return reply(response, 200, JSON.stringify(config.installation));
        }
        if (appRoute[3] !== undefined && method === "POST") {
          let asked: { repositories?: unknown; permissions?: unknown };
          try {
            asked = JSON.parse(body) as typeof asked;
          } catch {
            return reply(response, 400, "{}");
          }
          const names = Array.isArray(asked.repositories) ? (asked.repositories as string[]) : [];
          const granted = config.tokenPermissions ?? {
            ...(asked.permissions as Record<string, string>),
            metadata: "read",
          };
          return reply(
            response,
            201,
            JSON.stringify({
              token: config.tokenValue,
              expires_at: new Date(Date.now() + config.tokenLifetimeSeconds * 1000).toISOString(),
              permissions: granted,
              repository_selection: config.tokenSelection,
              repositories: (config.tokenRepositories ?? names).map((name) => ({ name })),
            }),
          );
        }
      }
      return reply(response, 404, JSON.stringify({ message: "Not Found" }));
    }

    // Everything else is read with the token of an installation, and a JWT is not one.
    if (credential !== config.tokenValue) return unauthorised();
    const repoRoute = new RegExp(`^/repos/${OWNER}/${REPOSITORY}(/.*)?$`).exec(path);
    if (repoRoute === null) return reply(response, 404, JSON.stringify({ message: "Not Found" }));
    const rest = repoRoute[1] ?? "";
    if (rest === "" && method === "GET")
      return reply(response, 200, JSON.stringify(config.repository));
    if (rest.startsWith("/commits/") && method === "GET") {
      return reply(response, 200, JSON.stringify({ sha: COMMIT }));
    }
    if (rest.startsWith("/tarball/") && method === "GET") {
      if (!REDIRECTS.has(config.tarballStatus)) return reply(response, config.tarballStatus, "{}");
      const location =
        config.tarballLocation === undefined
          ? `${base}/codeload/${OWNER}/${REPOSITORY}/tar.gz/${COMMIT}?token=${DOWNLOAD_CREDENTIAL}`
          : config.tarballLocation(base);
      response.writeHead(config.tarballStatus, location === undefined ? {} : { location });
      response.end();
      return;
    }
    if (rest === "/git/blobs" && method === "POST") {
      return reply(
        response,
        config.blobStatus,
        JSON.stringify({ message: "Resource not accessible by integration" }),
      );
    }
    return reply(response, 404, JSON.stringify({ message: "Not Found" }));
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return {
    url: base,
    config,
    requests,
    downloads: () => requests.filter((entry) => entry.path.startsWith("/codeload/")),
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

export const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** The settings that the check reads from the environment, for the fake: all of them valid. */
export function validEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    CODEMUGS_GITHUB_APP_ID: String(APP_ID),
    CODEMUGS_GITHUB_APP_CLIENT_ID: CLIENT_ID,
    CODEMUGS_GITHUB_APP_INSTALLATION_ID: String(INSTALLATION_ID),
    CODEMUGS_GITHUB_APP_PRIVATE_KEY: testKeys().privatePem,
    GITHUB_REPOSITORY: `${OWNER}/${REPOSITORY}`,
    ...overrides,
  };
}
