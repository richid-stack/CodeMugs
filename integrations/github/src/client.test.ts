import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubApp, type InstallationClient } from "./client.js";
import { GitHubError } from "./errors.js";
import {
  BODY_SENTINEL,
  CLIENT_ID,
  COMMIT,
  DOWNLOAD_CREDENTIAL,
  INSTALLATION_ID,
  INSTALLATION_TOKEN,
  OWNER,
  REPOSITORY,
  secretOf,
  sha256,
  startFakeGitHub,
  testKeys,
  type FakeConfig,
  type FakeGitHub,
  FAKE_CLIENT_SECRET,
} from "./test-harness.js";

let fake: FakeGitHub | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const start = async (overrides: Partial<FakeConfig> = {}): Promise<FakeGitHub> => {
  fake = await startFakeGitHub(overrides);
  return fake;
};

const appFor = (server: FakeGitHub, extra: Record<string, unknown> = {}): GitHubApp =>
  new GitHubApp(
    { clientId: CLIENT_ID, privateKey: secretOf(testKeys().privatePem) },
    { apiBaseUrl: server.url, downloadHosts: ["127.0.0.1"], ...extra },
  );

const readerFor = async (app: GitHubApp): Promise<InstallationClient> =>
  app.forInstallation(
    await app.createInstallationToken(INSTALLATION_ID, {
      repositories: [REPOSITORY],
      permissions: { contents: "read" },
    }),
  );

const failure = async (work: () => Promise<unknown>): Promise<GitHubError> => {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubError);
    return error as GitHubError;
  }
  throw new Error("it did not fail");
};

/** Everything that can be seen of an error: nothing of a credential or of a response may be in it. */
const visible = (error: GitHubError): string =>
  [error.message, error.stack ?? "", JSON.stringify(error), String(error), inspect(error)].join(
    "\n",
  );

describe("the app", () => {
  it("signs in with a JWT that GitHub would accept, and says which version of the API it uses", async () => {
    const server = await start();
    const info = await appFor(server).getApp();
    expect(info).toMatchObject({ id: 4242, clientId: CLIENT_ID, events: [] });
    const request = server.requests[0];
    expect(request?.path).toBe("/app");
    expect(request?.claims).toMatchObject({ iss: CLIENT_ID });
    expect(request?.headers["accept"]).toBe("application/vnd.github+json");
    expect(request?.headers["x-github-api-version"]).toBe("2026-03-10");
    expect(request?.headers["user-agent"]).toBe("codemugs");
  });

  it("uses another version of the API when it is told to", async () => {
    const server = await start();
    await appFor(server, { apiVersion: "2022-11-28" }).getApp();
    expect(server.requests[0]?.headers["x-github-api-version"]).toBe("2022-11-28");
  });

  it("makes a new JWT for each request", async () => {
    const server = await start();
    const app = appFor(server, { now: () => Date.now() });
    await app.getApp();
    await app.getInstallation(INSTALLATION_ID);
    const [first, second] = server.requests;
    expect(first?.claims).toBeDefined();
    expect(second?.claims).toBeDefined();
  });

  it("is not accepted with a key that GitHub does not know", async () => {
    const server = await start({
      publicPem: (await import("./test-harness.js")).otherKeys().publicPem,
    });
    const error = await failure(() => appFor(server).getApp());
    expect(error.code).toBe("request_failed");
    expect(error.status).toBe(401);
  });

  it("reads the installation, and says when it is suspended", async () => {
    const server = await start();
    expect(await appFor(server).getInstallation(INSTALLATION_ID)).toMatchObject({
      id: INSTALLATION_ID,
      appId: 4242,
      repositorySelection: "selected",
      suspended: false,
      account: { login: OWNER },
    });
    server.config.installation = {
      ...server.config.installation,
      suspended_at: "2026-11-01T00:00:00Z",
    };
    expect((await appFor(server).getInstallation(INSTALLATION_ID)).suspended).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "does not ask about the installation %s",
    async (value) => {
      const server = await start();
      const error = await failure(() => appFor(server).getInstallation(value));
      expect(error.code).toBe("invalid_input");
      expect(server.requests).toHaveLength(0);
    },
  );
});

describe("the address of the API", () => {
  it.each([
    "http://api.example.com",
    "ftp://127.0.0.1",
    "https://user:password@api.github.com",
    "https://api.github.com?x=1",
    "not a url",
  ])("refuses %s", (url) => {
    expect(
      () => new GitHubApp({ clientId: CLIENT_ID, privateKey: secretOf("x") }, { apiBaseUrl: url }),
    ).toThrow(GitHubError);
  });

  it("is GitHub's own by default, over https", async () => {
    let asked = "";
    const app = new GitHubApp(
      { clientId: CLIENT_ID, privateKey: secretOf(testKeys().privatePem) },
      {
        fetch: (url) => {
          asked = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
          return Promise.resolve(new Response("{}", { status: 500 }));
        },
      },
    );
    await failure(() => app.getApp());
    expect(asked).toBe("https://api.github.com/app");
  });
});

describe("a token for an installation", () => {
  it("is asked for one repository and one permission, and no more", async () => {
    const server = await start();
    const token = await appFor(server).createInstallationToken(INSTALLATION_ID, {
      repositories: [REPOSITORY],
      permissions: { contents: "read" },
    });
    const request = server.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe(`/app/installations/${String(INSTALLATION_ID)}/access_tokens`);
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request?.body ?? "")).toEqual({
      repositories: [REPOSITORY],
      permissions: { contents: "read" },
    });
    expect(token.repositories).toEqual([REPOSITORY]);
    expect(token.repositorySelection).toBe("selected");
    expect(token.permissions).toEqual({ contents: "read", metadata: "read" });
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("is a secret that cannot be printed by accident", async () => {
    const server = await start();
    const token = await appFor(server).createInstallationToken(INSTALLATION_ID, {
      repositories: [REPOSITORY],
      permissions: { contents: "read" },
    });
    expect(token.token.reveal()).toBe(INSTALLATION_TOKEN);
    for (const shown of [
      JSON.stringify(token),
      inspect(token, { depth: 5 }),
      String(token.token),
    ]) {
      expect(shown).not.toContain(INSTALLATION_TOKEN);
    }
  });

  it.each([
    ["no repository", { repositories: [], permissions: { contents: "read" as const } }],
    ["no permission", { repositories: [REPOSITORY], permissions: {} }],
    [
      "a repository that is a path",
      { repositories: ["../other"], permissions: { contents: "read" as const } },
    ],
    [
      "a repository with a slash",
      { repositories: ["a/b"], permissions: { contents: "read" as const } },
    ],
  ])("is not asked for with %s", async (_name, scope) => {
    const server = await start();
    const error = await failure(() =>
      appFor(server).createInstallationToken(INSTALLATION_ID, scope),
    );
    expect(error.code).toBe("invalid_input");
    expect(server.requests).toHaveLength(0);
  });

  it.each([
    [
      "no token",
      {
        token: "",
        expires_at: "2026-11-16T13:00:00Z",
        permissions: {},
        repository_selection: "selected",
      },
    ],
    [
      "a token with a space in it",
      {
        token: "a b",
        expires_at: "2026-11-16T13:00:00Z",
        permissions: {},
        repository_selection: "selected",
      },
    ],
    [
      "a token of an unreasonable length",
      {
        token: "a".repeat(5000),
        expires_at: "2026-11-16T13:00:00Z",
        permissions: {},
        repository_selection: "selected",
      },
    ],
    ["no expiry", { token: "abc", permissions: {}, repository_selection: "selected" }],
    [
      "an expiry that is not a date",
      {
        token: "abc",
        expires_at: "tomorrow-ish",
        permissions: {},
        repository_selection: "selected",
      },
    ],
    [
      "a selection that is not known",
      {
        token: "abc",
        expires_at: "2026-11-16T13:00:00Z",
        permissions: {},
        repository_selection: "some",
      },
    ],
  ])("is not believed when GitHub answers with %s", async (_name, answer) => {
    const server = await start({
      rawBodies: {
        [`POST /app/installations/${String(INSTALLATION_ID)}/access_tokens`]:
          JSON.stringify(answer),
      },
    });
    const error = await failure(() =>
      appFor(server).createInstallationToken(INSTALLATION_ID, {
        repositories: [REPOSITORY],
        permissions: { contents: "read" },
      }),
    );
    expect(error.code).toBe("response_rejected");
  });

  it("is not made at all when the key is not a key, and nothing is sent", async () => {
    const server = await start();
    const app = new GitHubApp(
      { clientId: CLIENT_ID, privateKey: secretOf(FAKE_CLIENT_SECRET) },
      { apiBaseUrl: server.url },
    );
    const error = await failure(() => app.getApp());
    expect(error.code).toBe("key_invalid");
    expect(server.requests).toHaveLength(0);
  });
});

describe("what GitHub answers is data, not to be believed unchecked", () => {
  const appRoute = "GET /app";

  it.each([
    ["not JSON", "<html>login</html>"],
    ["JSON that is not an object", "[]"],
    ["an app without an id", JSON.stringify({ name: "x", permissions: {}, events: [] })],
    [
      "an app whose id is a string",
      JSON.stringify({ id: "1", name: "x", permissions: {}, events: [] }),
    ],
    [
      "permissions that are not strings",
      JSON.stringify({ id: 1, name: "x", permissions: { contents: 1 }, events: [] }),
    ],
    [
      "events that are not a list",
      JSON.stringify({ id: 1, name: "x", permissions: {}, events: "push" }),
    ],
  ])("rejects %s", async (_name, body) => {
    const server = await start({ rawBodies: { [appRoute]: body } });
    const error = await failure(() => appFor(server).getApp());
    expect(error.code).toBe("response_rejected");
    expect(visible(error)).not.toContain("login");
  });

  const LIMIT = 1_048_576;
  /** A valid answer of exactly this many bytes: JSON, then spaces, which JSON allows. */
  const padded = (bytes: number): Uint8Array => {
    const json = JSON.stringify({ id: 4242, name: "x", permissions: {}, events: [] });
    return new TextEncoder().encode(json + " ".repeat(bytes - json.length));
  };
  /** An answer that does not say how long it is, sent in pieces. */
  const streamed = (bytes: Uint8Array): GitHubApp =>
    new GitHubApp(
      { clientId: CLIENT_ID, privateKey: secretOf(testKeys().privatePem) },
      {
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  const piece = Math.ceil(bytes.length / 3);
                  for (let at = 0; at < bytes.length; at += piece) {
                    controller.enqueue(bytes.slice(at, at + piece));
                  }
                  controller.close();
                },
              }),
              { status: 200 },
            ),
          ),
      },
    );

  it("does not take a success with no body for an answer", async () => {
    const app = new GitHubApp(
      { clientId: CLIENT_ID, privateKey: secretOf(testKeys().privatePem) },
      { fetch: () => Promise.resolve(new Response(null, { status: 200 })) },
    );
    expect((await failure(() => app.getApp())).code).toBe("response_rejected");
  });

  it("refuses an answer that says it is too large without reading any of it", async () => {
    let pulled = 0;
    const app = new GitHubApp(
      { clientId: CLIENT_ID, privateKey: secretOf(testKeys().privatePem) },
      {
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  pulled += 1;
                  controller.enqueue(new Uint8Array(1024));
                },
              }),
              { status: 200, headers: { "content-length": String(LIMIT + 1) } },
            ),
          ),
      },
    );
    expect((await failure(() => app.getApp())).code).toBe("response_rejected");
    // A stream is asked for one piece when it is made. Reading to the limit would be a thousand.
    expect(pulled).toBeLessThanOrEqual(2);
  });

  it("takes an answer of exactly the limit, and refuses one byte more, when it says how long it is", async () => {
    const exact = await start({
      rawBodies: { [appRoute]: new TextDecoder().decode(padded(LIMIT)) },
    });
    expect((await appFor(exact).getApp()).id).toBe(4242);
    await exact.close();
    const over = await start({
      rawBodies: { [appRoute]: new TextDecoder().decode(padded(LIMIT + 1)) },
    });
    fake = over;
    expect((await failure(() => appFor(over).getApp())).code).toBe("response_rejected");
  });

  it("takes an answer of exactly the limit, and refuses one byte more, when it does not say how long it is", async () => {
    expect((await streamed(padded(LIMIT)).getApp()).id).toBe(4242);
    expect((await failure(() => streamed(padded(LIMIT + 1)).getApp())).code).toBe(
      "response_rejected",
    );
  });

  it("refuses an answer that never ends, once it is past the limit", async () => {
    const chunk = new Uint8Array(600 * 1024).fill(32);
    const app = new GitHubApp(
      { clientId: CLIENT_ID, privateKey: secretOf(testKeys().privatePem) },
      {
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  controller.enqueue(chunk);
                },
              }),
              { status: 200 },
            ),
          ),
      },
    );
    expect((await failure(() => app.getApp())).code).toBe("response_rejected");
  });

  it.each([300, 301, 400, 401, 403, 404, 422, 500, 503])(
    "turns a %s into request_failed with the status, and says nothing of the body or the credential",
    async (status) => {
      const server = await start({ failRoutes: { [appRoute]: status } });
      const error = await failure(() => appFor(server).getApp());
      expect(error.code).toBe("request_failed");
      expect(error.status).toBe(status);
      const jwt = server.requests[0]?.headers["authorization"]?.slice("Bearer ".length) ?? "";
      expect(jwt.length).toBeGreaterThan(20);
      expect(visible(error)).not.toContain(BODY_SENTINEL);
      expect(visible(error)).not.toContain(jwt);
    },
  );

  it("turns a refused connection into request_failed", async () => {
    const server = await start();
    const url = server.url;
    await server.close();
    fake = undefined;
    const app = new GitHubApp(
      { clientId: CLIENT_ID, privateKey: secretOf(testKeys().privatePem) },
      { apiBaseUrl: url },
    );
    expect((await failure(() => app.getApp())).code).toBe("request_failed");
  });

  it("turns a slow answer into timed_out", async () => {
    const server = await start({ delayMs: 400 });
    const error = await failure(() => appFor(server, { timeoutMs: 60 }).getApp());
    expect(error.code).toBe("timed_out");
  });
});

describe("reading a repository with a token", () => {
  it("sends the token of the installation, and not a JWT, to the routes of the repository", async () => {
    const server = await start();
    const reader = await readerFor(appFor(server));
    const repository = await reader.getRepository(OWNER, REPOSITORY);
    expect(repository).toEqual({
      id: 99,
      name: REPOSITORY,
      fullName: `${OWNER}/${REPOSITORY}`,
      private: false,
      defaultBranch: "main",
    });
    const read = server.requests.at(-1);
    expect(read?.path).toBe(`/repos/${OWNER}/${REPOSITORY}`);
    expect(read?.headers["authorization"]).toBe(`Bearer ${INSTALLATION_TOKEN}`);
    expect(read?.claims).toBeUndefined();
  });

  it("does not take a repository with no default branch", async () => {
    const base = (await startFakeGitHub()).config.repository;
    await fake?.close();
    const server = await start({ repository: { ...base, default_branch: "" } });
    const reader = await readerFor(appFor(server));
    expect((await failure(() => reader.getRepository(OWNER, REPOSITORY))).code).toBe(
      "response_rejected",
    );
  });

  it("gives the commit id of a branch, with the parts of the name encoded", async () => {
    const server = await start();
    const reader = await readerFor(appFor(server));
    expect(await reader.getCommitId(OWNER, REPOSITORY, "feature/new-thing")).toBe(COMMIT);
    expect(server.requests.at(-1)?.path).toBe(
      `/repos/${OWNER}/${REPOSITORY}/commits/feature/new-thing`,
    );
    await reader.getCommitId(OWNER, REPOSITORY, "v1.0-x");
    expect(server.requests.at(-1)?.path).toBe(`/repos/${OWNER}/${REPOSITORY}/commits/v1.0-x`);
  });

  it.each([
    ["an owner with a space", "acme owner", REPOSITORY],
    ["an owner that starts with a hyphen", "-acme", REPOSITORY],
    ["an owner that is too long", "a".repeat(40), REPOSITORY],
    ["an owner that is empty", "", REPOSITORY],
    ["an owner with a slash", "a/b", REPOSITORY],
    ["a repository that is ..", OWNER, ".."],
    ["a repository that is .", OWNER, "."],
    ["a repository with a slash", OWNER, "a/b"],
    ["a repository that is empty", OWNER, ""],
    ["a repository that is too long", OWNER, "a".repeat(101)],
  ])("sends nothing for %s, whichever read it is for", async (_name, ownerName, repositoryName) => {
    const server = await start();
    const reader = await readerFor(appFor(server));
    const before = server.requests.length;
    for (const work of [
      () => reader.getRepository(ownerName, repositoryName),
      () => reader.getCommitId(ownerName, repositoryName, "main"),
      () => reader.downloadTarball(ownerName, repositoryName, "main", { maxBytes: 1000 }),
      () => reader.probeWrite(ownerName, repositoryName),
    ]) {
      expect((await failure(work)).code).toBe("invalid_input");
    }
    expect(server.requests).toHaveLength(before);
  });

  it.each([
    ["a reference with ..", "../../other"],
    ["a reference that is only ..", ".."],
    ["a reference with a . part", "a/./b"],
    ["a reference with an empty part", "a//b"],
    ["a reference that starts with a slash", "/main"],
    ["a reference that ends with a slash", "main/"],
    ["a reference with a space", "a b"],
    ["a reference with a query", "main?x=1"],
    ["a reference with a fragment", "main#x"],
    ["a reference with a percent sign", "main%2e%2e"],
    ["a reference that is empty", ""],
    ["a reference that is too long", "a".repeat(201)],
  ])("sends nothing for %s", async (_name, ref) => {
    const server = await start();
    const reader = await readerFor(appFor(server));
    const before = server.requests.length;
    for (const work of [
      () => reader.getCommitId(OWNER, REPOSITORY, ref),
      () => reader.downloadTarball(OWNER, REPOSITORY, ref, { maxBytes: 1000 }),
    ]) {
      expect((await failure(work)).code).toBe("invalid_input");
    }
    expect(server.requests).toHaveLength(before);
  });

  it("rejects a commit id that is not one", async () => {
    const path = `GET /repos/${OWNER}/${REPOSITORY}/commits/main`;
    for (const sha of ["abc", "z".repeat(40), "A".repeat(40), "0".repeat(41)]) {
      const server = await start({ rawBodies: { [path]: JSON.stringify({ sha }) } });
      const reader = await readerFor(appFor(server));
      expect((await failure(() => reader.getCommitId(OWNER, REPOSITORY, "main"))).code).toBe(
        "response_rejected",
      );
      await server.close();
      fake = undefined;
    }
  });

  it("accepts a SHA-256 commit id", async () => {
    const sha = "ab".repeat(32);
    const server = await start({
      rawBodies: { [`GET /repos/${OWNER}/${REPOSITORY}/commits/main`]: JSON.stringify({ sha }) },
    });
    expect(await (await readerFor(appFor(server))).getCommitId(OWNER, REPOSITORY, "main")).toBe(
      sha,
    );
  });
});

describe("downloading the repository", () => {
  const download = (reader: InstallationClient, maxBytes: number, chunks?: Uint8Array[]) =>
    reader.downloadTarball(OWNER, REPOSITORY, COMMIT, {
      maxBytes,
      ...(chunks === undefined
        ? {}
        : { onChunk: (chunk: Uint8Array) => void chunks.push(chunk.slice()) }),
    });

  it("follows the redirect, counts the bytes, and hashes them", async () => {
    const server = await start({ chunkSize: 700 });
    const reader = await readerFor(appFor(server));
    const chunks: Uint8Array[] = [];
    const result = await download(reader, 1_000_000, chunks);
    expect(result).toEqual({
      bytes: server.config.tarball.length,
      sha256: sha256(server.config.tarball),
    });
    expect(Buffer.concat(chunks).equals(server.config.tarball)).toBe(true);
  });

  it("sends the token to the API and nothing of ours to the host that serves the archive", async () => {
    const server = await start();
    const reader = await readerFor(appFor(server));
    await download(reader, 1_000_000);
    const [served] = server.downloads();
    expect(served).toBeDefined();
    expect(served?.headers["authorization"]).toBeUndefined();
    expect(Object.keys(served?.headers ?? {})).not.toContain("x-github-api-version");
    const api = server.requests.find((entry) => entry.path.includes("/tarball/"));
    expect(api?.headers["authorization"]).toBe(`Bearer ${INSTALLATION_TOKEN}`);
  });

  it.each([
    ["a host that is not allowed", () => "https://evil.example.com/x.tar.gz"],
    [
      "another name for this machine, that is not allowed",
      (base: string) => base.replace("127.0.0.1", "localhost") + "/codeload/x",
    ],
    ["plain http to a host that is not this machine", () => "http://codeload.github.com/x"],
    [
      "an address with a login in it",
      (base: string) => base.replace("http://", "http://user:pw@") + "/codeload/x",
    ],
    ["an address with a fragment", (base: string) => `${base}/codeload/x#frag`],
    ["a scheme that is not http", () => "file:///etc/passwd"],
    ["something that is not an address", () => "not a url"],
  ])("refuses a redirect to %s, and requests nothing there", async (_name, location) => {
    const server = await start({ tarballLocation: location });
    const reader = await readerFor(appFor(server));
    const error = await failure(() => download(reader, 1_000_000));
    expect(error.code).toBe("redirect_refused");
    expect(server.downloads()).toHaveLength(0);
    expect(visible(error)).not.toContain(DOWNLOAD_CREDENTIAL);
  });

  it("refuses a port on a host that is allowed, unless it is this machine", async () => {
    const server = await start({ tarballLocation: () => "https://codeload.github.com:8443/x" });
    const app = new GitHubApp(
      { clientId: CLIENT_ID, privateKey: secretOf(testKeys().privatePem) },
      { apiBaseUrl: server.url },
    );
    const reader = await readerFor(app);
    expect((await failure(() => download(reader, 1000))).code).toBe("redirect_refused");
  });

  it("refuses a redirect with no address, and an answer that is not a redirect", async () => {
    const none = await start({ tarballLocation: () => undefined });
    expect((await failure(async () => download(await readerFor(appFor(none)), 1000))).code).toBe(
      "response_rejected",
    );
    await none.close();
    const direct = await start({ tarballStatus: 200 });
    fake = direct;
    expect((await failure(async () => download(await readerFor(appFor(direct)), 1000))).code).toBe(
      "response_rejected",
    );
  });

  it("turns an error of the API, or of the host that serves the archive, into request_failed", async () => {
    const api = await start({ tarballStatus: 404 });
    const first = await failure(async () => download(await readerFor(appFor(api)), 1000));
    expect([first.code, first.status]).toEqual(["request_failed", 404]);
    await api.close();
    const host = await start({ downloadStatus: 500 });
    fake = host;
    const second = await failure(async () => download(await readerFor(appFor(host)), 1000));
    expect([second.code, second.status]).toEqual(["request_failed", 500]);
  });

  it("does not follow a second redirect from the host that serves the archive", async () => {
    const server = await start({ downloadStatus: 302 });
    const error = await failure(async () => download(await readerFor(appFor(server)), 1000));
    expect(error.code).toBe("request_failed");
    expect(server.downloads().map((entry) => entry.path.split("?")[0])).toHaveLength(1);
    expect(server.downloads().some((entry) => entry.path.startsWith("/codeload/second"))).toBe(
      false,
    );
  });

  it.each([301, 302, 303, 307, 308])("follows a redirect of %s", async (status) => {
    const server = await start({ tarballStatus: status });
    const result = await download(await readerFor(appFor(server)), 1_000_000);
    expect(result.bytes).toBe(server.config.tarball.length);
  });

  it.each([300, 304, 305])("does not take a %s for a redirect", async (status) => {
    const server = await start({ tarballStatus: status });
    const error = await failure(async () => download(await readerFor(appFor(server)), 1000));
    expect([error.code, error.status]).toEqual(["request_failed", status]);
    expect(server.downloads()).toHaveLength(0);
  });

  it("refuses a download that says it is too large without reading any of it", async () => {
    let pulled = 0;
    const answer = (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/access_tokens")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: "t",
              expires_at: "2099-01-01T00:00:00Z",
              permissions: { contents: "read" },
              repository_selection: "selected",
              repositories: [{ name: REPOSITORY }],
            }),
            { status: 201 },
          ),
        );
      }
      if (url.includes("/tarball/")) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://codeload.github.com/o/r?token=a" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new Uint8Array(1024));
            },
          }),
          { status: 200, headers: { "content-length": "100000" } },
        ),
      );
    };
    const app = new GitHubApp(
      { clientId: CLIENT_ID, privateKey: secretOf(testKeys().privatePem) },
      { fetch: answer },
    );
    const reader = await readerFor(app);
    const error = await failure(() =>
      reader.downloadTarball(OWNER, REPOSITORY, COMMIT, { maxBytes: 99_999 }),
    );
    expect(error.code).toBe("download_too_large");
    expect(pulled).toBeLessThanOrEqual(2);
  });

  it.each([true, false])(
    "accepts exactly the limit and refuses one byte less (content-length sent: %s)",
    async (sendContentLength) => {
      const server = await start({ sendContentLength, chunkSize: 500 });
      const reader = await readerFor(appFor(server));
      const size = server.config.tarball.length;
      expect((await download(reader, size)).bytes).toBe(size);
      const error = await failure(() => download(reader, size - 1));
      expect(error.code).toBe("download_too_large");
    },
  );

  it("stops reading a download that is larger than the limit, and does not hand on what is over", async () => {
    const server = await start({
      sendContentLength: false,
      chunkSize: 512,
      tarball: Buffer.alloc(64 * 1024, 7),
    });
    const reader = await readerFor(appFor(server));
    const chunks: Uint8Array[] = [];
    const error = await failure(() => download(reader, 2048, chunks));
    expect(error.code).toBe("download_too_large");
    expect(chunks.reduce((total, chunk) => total + chunk.length, 0)).toBeLessThanOrEqual(2048);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not accept a limit of %s",
    async (limit) => {
      const server = await start();
      const reader = await readerFor(appFor(server));
      const before = server.requests.length;
      expect((await failure(() => download(reader, limit))).code).toBe("invalid_input");
      expect(server.requests).toHaveLength(before);
    },
  );

  it("stops with sink_failed when what receives the bytes fails, and does not repeat what it said", async () => {
    const server = await start();
    const reader = await readerFor(appFor(server));
    const error = await failure(() =>
      reader.downloadTarball(OWNER, REPOSITORY, COMMIT, {
        maxBytes: 1_000_000,
        onChunk: () => {
          throw new Error("disk is full: /secret/path");
        },
      }),
    );
    expect(error.code).toBe("sink_failed");
    expect(visible(error)).not.toContain("/secret/path");
  });

  it("waits for a sink that is slow, and keeps the bytes in order", async () => {
    const server = await start({ chunkSize: 1000 });
    const reader = await readerFor(appFor(server));
    const seen: Buffer[] = [];
    await reader.downloadTarball(OWNER, REPOSITORY, COMMIT, {
      maxBytes: 1_000_000,
      onChunk: async (chunk) => {
        await new Promise((done) => setTimeout(done, 2));
        seen.push(Buffer.from(chunk));
      },
    });
    expect(Buffer.concat(seen).equals(server.config.tarball)).toBe(true);
  });

  it("times out a download that is too slow", async () => {
    const server = await start({ delayMs: 400 });
    const reader = await readerFor(appFor(server, { timeoutMs: 5000, downloadTimeoutMs: 80 }));
    const error = await failure(() => download(reader, 1_000_000));
    expect(error.code).toBe("timed_out");
  });
});

describe("trying to write", () => {
  it("reports the status, which a token that only reads gets as a refusal", async () => {
    const server = await start();
    const reader = await readerFor(appFor(server));
    expect(await reader.probeWrite(OWNER, REPOSITORY)).toBe(403);
    const request = server.requests.at(-1);
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe(`/repos/${OWNER}/${REPOSITORY}/git/blobs`);
    // An empty body, so that if it were allowed it would be invalid and make nothing.
    expect(JSON.parse(request?.body ?? "")).toEqual({});
  });

  it.each([201, 404, 422, 500])("reports %s as it is", async (status) => {
    const server = await start({ blobStatus: status });
    expect(await (await readerFor(appFor(server))).probeWrite(OWNER, REPOSITORY)).toBe(status);
  });
});

describe("the address of the API, on this machine", () => {
  it.each(["http://127.0.0.1:9", "http://localhost:9", "http://[::1]:9", "https://api.github.com"])(
    "accepts %s",
    (url) => {
      expect(
        () =>
          new GitHubApp({ clientId: CLIENT_ID, privateKey: secretOf("x") }, { apiBaseUrl: url }),
      ).not.toThrow();
    },
  );
});

describe("when the network fails in the ways that it can", () => {
  const failing = (error: unknown): GitHubApp =>
    new GitHubApp(
      { clientId: CLIENT_ID, privateKey: secretOf(testKeys().privatePem) },
      {
        // The thing that is thrown is whatever the test says, even when it is not an error.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        fetch: () => Promise.reject(error),
      },
    );

  it.each([
    ["a timeout", new DOMException("too slow, key=SECRET", "TimeoutError"), "timed_out"],
    ["an abort", new DOMException("aborted, key=SECRET", "AbortError"), "timed_out"],
    ["a failure to connect", new TypeError("fetch failed: ECONNREFUSED SECRET"), "request_failed"],
    ["something that is not an error", "SECRET", "request_failed"],
    ["nothing", undefined, "request_failed"],
    ["null", null, "request_failed"],
  ])("turns %s into %s, without what it said", async (_name, thrown, code) => {
    const error = await failure(() => failing(thrown).getApp());
    expect(error.code).toBe(code);
    expect(visible(error)).not.toContain("SECRET");
  });
});

describe("the shape of a token", () => {
  const answer = (token: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      token,
      expires_at: "2099-01-01T00:00:00Z",
      permissions: { contents: "read" },
      repository_selection: "selected",
      repositories: [{ name: REPOSITORY }],
      ...extra,
    });
  const route = `POST /app/installations/${String(INSTALLATION_ID)}/access_tokens`;
  const ask = (server: FakeGitHub) =>
    appFor(server).createInstallationToken(INSTALLATION_ID, {
      repositories: [REPOSITORY],
      permissions: { contents: "read" },
    });

  it("is accepted at 4,096 characters and refused at 4,097", async () => {
    const long = await start({ rawBodies: { [route]: answer("a".repeat(4096)) } });
    expect((await ask(long)).token.reveal()).toHaveLength(4096);
    await long.close();
    const longer = await start({ rawBodies: { [route]: answer("a".repeat(4097)) } });
    fake = longer;
    expect((await failure(() => ask(longer))).code).toBe("response_rejected");
  });

  it("is accepted with a single character, which is not a length that is promised", async () => {
    const server = await start({ rawBodies: { [route]: answer("a") } });
    expect((await ask(server)).token.reveal()).toBe("a");
  });

  it("has no repositories when GitHub does not list any", async () => {
    const rest = Object.fromEntries(
      Object.entries(JSON.parse(answer("abc")) as Record<string, unknown>).filter(
        ([key]) => key !== "repositories",
      ),
    );
    const server = await start({ rawBodies: { [route]: JSON.stringify(rest) } });
    expect((await ask(server)).repositories).toEqual([]);
  });
});
