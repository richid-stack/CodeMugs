import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tarball } from "@codemugs/archive/testing";
import { afterEach, describe, expect, it } from "vitest";
import { formatReport, readsContentsOnly, runCheck, type CheckReport } from "./check.js";
import { loadGitHubAppConfig } from "./config.js";
import {
  BODY_SENTINEL,
  COMMIT,
  DOWNLOAD_CREDENTIAL,
  INSTALLATION_ID,
  INSTALLATION_TOKEN,
  OWNER,
  REPOSITORY,
  otherKeys,
  repositoryArchive,
  sha256,
  secretOf,
  startFakeGitHub,
  testKeys,
  validEnv,
  type FakeConfig,
  type FakeGitHub,
  FAKE_CLIENT_SECRET,
} from "./test-harness.js";

let fake: FakeGitHub | undefined;
const workspaces: string[] = [];
afterEach(async () => {
  await fake?.close();
  fake = undefined;
  for (const workspace of workspaces.splice(0))
    await rm(workspace, { recursive: true, force: true });
});

const NAMES = [
  "the key signs in as the app",
  "it is the app that was meant",
  "the app can only read contents",
  "the app has no webhook events",
  "the app is installed",
  "it is installed for this owner only",
  "it is installed on chosen repositories, not all",
  "the installation can only read contents",
  "the installation is not suspended",
  "a token can be made",
  "the token is for one repository",
  "the token can only read contents",
  "the repository can be read",
  "the latest commit can be read",
  "the repository can be downloaded",
  "the download can be unpacked",
  "a write is refused",
] as const;

interface Run {
  readonly report: CheckReport;
  readonly server: FakeGitHub;
  /** The folder that the download was unpacked in, which is the check's to leave empty. */
  readonly workspace: string;
}

const run = async (
  overrides: Partial<FakeConfig> = {},
  options: {
    readonly maxDownloadBytes?: number;
    readonly unpackRoot?: (workspace: string) => string;
    readonly privateKey?: string;
    readonly now?: () => number;
  } = {},
): Promise<Run> => {
  const server = await startFakeGitHub(overrides);
  fake = server;
  const workspace = await mkdtemp(join(tmpdir(), "codemugs-check-test-"));
  workspaces.push(workspace);
  const config = loadGitHubAppConfig(validEnv());
  const report = await runCheck({
    config:
      options.privateKey === undefined
        ? config
        : { ...config, privateKey: secretOf(options.privateKey) },
    owner: OWNER,
    repository: REPOSITORY,
    apiBaseUrl: server.url,
    downloadHosts: ["127.0.0.1"],
    unpackRoot: options.unpackRoot?.(workspace) ?? workspace,
    ...(options.maxDownloadBytes === undefined
      ? {}
      : { maxDownloadBytes: options.maxDownloadBytes }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { report, server, workspace };
};

const failed = (report: CheckReport): string[] =>
  report.results.filter((result) => !result.ok).map((result) => result.name);

const detail = (report: CheckReport, name: string): string =>
  report.results.find((result) => result.name === name)?.detail ?? "(missing)";

describe("a setup that is right", () => {
  it("passes every check, in order", async () => {
    const { report } = await run();
    expect(report.results.map((result) => result.name)).toEqual(NAMES);
    expect(failed(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(detail(report, "a write is refused")).toBe("HTTP 403");
    expect(detail(report, "the latest commit can be read")).toBe(COMMIT.slice(0, 12));
  });

  it("says exactly what it found, and nothing more", async () => {
    const { report, server } = await run();
    const hash = sha256(server.config.tarball).slice(0, 12);
    expect(report.results.map((result) => [result.name, result.detail])).toEqual([
      ["the key signs in as the app", "app 4242"],
      ["it is the app that was meant", "app id matches, client id matches"],
      ["the app can only read contents", "permissions contents:read,metadata:read"],
      ["the app has no webhook events", "0 events"],
      ["the app is installed", "installation 7001 of app 4242"],
      ["it is installed for this owner only", "account acme-owner (User)"],
      ["it is installed on chosen repositories, not all", "repository_selection selected"],
      ["the installation can only read contents", "permissions contents:read,metadata:read"],
      ["the installation is not suspended", "active"],
      ["a token can be made", "lasts 60 minutes"],
      ["the token is for one repository", "selected, 1 repository"],
      ["the token can only read contents", "permissions contents:read,metadata:read"],
      ["the repository can be read", "acme-owner/widgets, public, default branch main"],
      ["the latest commit can be read", COMMIT.slice(0, 12)],
      [
        "the repository can be downloaded",
        `${String(server.config.tarball.length)} bytes, sha256 ${hash}`,
      ],
      ["the download can be unpacked", "files 2, directories 1, content 36 bytes, copy removed"],
      ["a write is refused", "HTTP 403"],
    ]);
  });

  it("changes nothing: the only things that it posts are the token request and the refused write", async () => {
    const { server } = await run();
    const posts = server.requests.filter((entry) => entry.method !== "GET");
    expect(posts.map((entry) => entry.path)).toEqual([
      `/app/installations/${String(INSTALLATION_ID)}/access_tokens`,
      `/repos/${OWNER}/${REPOSITORY}/git/blobs`,
    ]);
    expect(JSON.parse(posts[0]?.body ?? "")).toEqual({
      repositories: [REPOSITORY],
      permissions: { contents: "read" },
    });
    expect(JSON.parse(posts[1]?.body ?? "")).toEqual({});
  });

  it("downloads the repository with no credential of ours, and says only how big it is and its hash", async () => {
    const { report, server } = await run();
    expect(server.downloads()).toHaveLength(1);
    expect(server.downloads()[0]?.headers["authorization"]).toBeUndefined();
    expect(detail(report, "the repository can be downloaded")).toMatch(
      new RegExp(`^${String(server.config.tarball.length)} bytes, sha256 [0-9a-f]{12}$`),
    );
  });

  it("prints nothing that is secret", async () => {
    const { report, server } = await run();
    const text = formatReport(report);
    const jwt = server.requests[0]?.headers["authorization"]?.slice("Bearer ".length) ?? "";
    expect(jwt.split(".")).toHaveLength(3);
    for (const secret of [
      INSTALLATION_TOKEN,
      DOWNLOAD_CREDENTIAL,
      jwt,
      jwt.split(".")[2] ?? "",
      "BEGIN",
      "eyJ",
    ]) {
      expect(text).not.toContain(secret);
    }
    for (const line of testKeys().privatePem.trim().split("\n").slice(1, 4)) {
      expect(text).not.toContain(line);
    }
  });
});

describe("the app is not the one that was meant", () => {
  it.each([
    [
      "an App ID that is not the one expected",
      { app: { id: 999 } },
      "it is the app that was meant",
    ],
    [
      "a Client ID that is not the one expected",
      { app: { client_id: "IvSomeoneElse000001" } },
      "it is the app that was meant",
    ],
    [
      "permission to write contents",
      { app: { permissions: { contents: "write", metadata: "read" } } },
      "the app can only read contents",
    ],
    [
      "a permission beyond contents",
      { app: { permissions: { contents: "read", metadata: "read", issues: "read" } } },
      "the app can only read contents",
    ],
    [
      "no permission to read contents",
      { app: { permissions: { metadata: "read" } } },
      "the app can only read contents",
    ],
    [
      "metadata with more than read",
      { app: { permissions: { contents: "read", metadata: "write" } } },
      "the app can only read contents",
    ],
    ["a webhook event", { app: { events: ["push"] } }, "the app has no webhook events"],
  ] as const)("fails, and only, for %s", async (_name, change, name) => {
    const base = (await startFakeGitHub()).config.app;
    await fake?.close();
    const { report } = await run({ app: { ...base, ...change.app } });
    expect(failed(report)).toEqual([name]);
    expect(report.ok).toBe(false);
  });

  it("says when there are no permissions at all", async () => {
    const base = (await startFakeGitHub()).config.app;
    await fake?.close();
    const { report } = await run({ app: { ...base, permissions: {} } });
    expect(detail(report, "the app can only read contents")).toBe("permissions none");
  });

  it("accepts an app that does not show its Client ID, since its App ID was checked", async () => {
    const base = (await startFakeGitHub()).config.app;
    await fake?.close();
    const without = Object.fromEntries(Object.entries(base).filter(([key]) => key !== "client_id"));
    const { report } = await run({ app: without });
    expect(failed(report)).toEqual([]);
    expect(detail(report, "it is the app that was meant")).toContain("client id not shown");
  });
});

describe("the installation is not the one that was meant", () => {
  const change = async (patch: Record<string, unknown>) => {
    const base = (await startFakeGitHub()).config.installation;
    await fake?.close();
    return run({ installation: { ...base, ...patch } });
  };

  it.each([
    ["belongs to another app", { app_id: 999 }, "the app is installed"],
    [
      "is on another account",
      { account: { login: "someone-else", type: "User" } },
      "it is installed for this owner only",
    ],
    ["is on no account", { account: null }, "it is installed for this owner only"],
    [
      "is on all repositories",
      { repository_selection: "all" },
      "it is installed on chosen repositories, not all",
    ],
    [
      "may write contents",
      { permissions: { contents: "write", metadata: "read" } },
      "the installation can only read contents",
    ],
    ["is suspended", { suspended_at: "2026-11-01T00:00:00Z" }, "the installation is not suspended"],
  ] as const)("fails, and only, when it %s", async (_name, patch, name) => {
    const { report } = await change(patch);
    expect(failed(report)).toEqual([name]);
  });

  it("takes the account name in any case, as GitHub does", async () => {
    const { report } = await change({
      account: { login: OWNER.toUpperCase(), type: "Organization" },
    });
    expect(failed(report)).toEqual([]);
  });
});

describe("the token is wider than it should be", () => {
  const wider: readonly (readonly [string, Partial<FakeConfig>, string])[] = [
    [
      "it can write contents",
      { tokenPermissions: { contents: "write", metadata: "read" } },
      "the token can only read contents",
    ],
    [
      "it has another permission",
      { tokenPermissions: { contents: "read", metadata: "read", issues: "read" } },
      "the token can only read contents",
    ],
    ["it is for all repositories", { tokenSelection: "all" }, "the token is for one repository"],
    [
      "it is for two repositories",
      { tokenRepositories: [REPOSITORY, "other"] },
      "the token is for one repository",
    ],
    [
      "it is for another repository",
      { tokenRepositories: ["other"] },
      "the token is for one repository",
    ],
    ["it is for no repository", { tokenRepositories: [] }, "the token is for one repository"],
  ];

  it.each(wider)("fails, and only, when %s", async (_name, patch, name) => {
    const { report } = await run(patch);
    expect(failed(report)).toEqual([name]);
  });

  it("accepts a token with only contents, which is all that was asked for", async () => {
    const { report } = await run({ tokenPermissions: { contents: "read" } });
    expect(failed(report)).toEqual([]);
  });

  it.each([
    ["lasts hours", 3 * 3600],
    ["lasts a little over the hour", 3901],
    ["has already expired", -10],
  ])("fails when the token %s", async (_name, seconds) => {
    const { report } = await run({ tokenLifetimeSeconds: seconds });
    expect(failed(report)).toEqual(["a token can be made"]);
  });

  it("judges how long the token lasts by the clock that it is given", async () => {
    // 3,930 seconds is too long by the real clock and right by one that is 50 seconds ahead
    // (the most that a JWT's issue time allows).
    const ahead = () => Date.now() + 50_000;
    expect(failed((await run({ tokenLifetimeSeconds: 3930 })).report)).toEqual([
      "a token can be made",
    ]);
    await fake?.close();
    expect(failed((await run({ tokenLifetimeSeconds: 3930 }, { now: ahead })).report)).toEqual([]);
  });

  it.each([60, 3600, 3899])("accepts a token that lasts %s seconds", async (seconds) => {
    expect(failed((await run({ tokenLifetimeSeconds: seconds })).report)).toEqual([]);
  });
});

describe("a write that is not refused", () => {
  it.each([200, 201, 422, 500])("fails when it is answered with %s", async (status) => {
    const { report } = await run({ blobStatus: status });
    expect(failed(report)).toEqual(["a write is refused"]);
    expect(detail(report, "a write is refused")).toBe(`HTTP ${String(status)}`);
  });

  it.each([403, 404])("passes when it is refused with %s", async (status) => {
    expect(failed((await run({ blobStatus: status })).report)).toEqual([]);
  });
});

describe("what cannot be read", () => {
  it("stops at the first check when the key is a client secret, and sends nothing", async () => {
    const { report, server } = await run({}, { privateKey: FAKE_CLIENT_SECRET });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      name: "the key signs in as the app",
      ok: false,
      detail: "key_invalid",
    });
    expect(server.requests).toHaveLength(0);
    expect(formatReport(report)).not.toContain(FAKE_CLIENT_SECRET);
  });

  it("stops at the first check when GitHub does not know the key", async () => {
    const { report } = await run({ publicPem: otherKeys().publicPem });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ ok: false, detail: "request_failed (HTTP 401)" });
  });

  it("stops after the app when the installation cannot be read", async () => {
    const { report } = await run({
      failRoutes: { [`GET /app/installations/${String(INSTALLATION_ID)}`]: 404 },
    });
    expect(report.results.map((result) => result.name)).toEqual([
      ...NAMES.slice(0, 4),
      "the app is installed",
    ]);
    expect(failed(report)).toEqual(["the app is installed"]);
  });

  it("stops after the installation when no token is made, and says nothing of the answer", async () => {
    const { report } = await run({
      failRoutes: { [`POST /app/installations/${String(INSTALLATION_ID)}/access_tokens`]: 422 },
    });
    expect(failed(report)).toEqual(["a token can be made"]);
    expect(report.results).toHaveLength(10);
    expect(detail(report, "a token can be made")).toBe("request_failed (HTTP 422)");
    expect(formatReport(report)).not.toContain(BODY_SENTINEL);
  });

  it("goes on to try the write when the repository cannot be read, and skips what needs it", async () => {
    const { report } = await run({ failRoutes: { [`GET /repos/${OWNER}/${REPOSITORY}`]: 404 } });
    expect(failed(report)).toEqual(["the repository can be read"]);
    expect(report.results.map((result) => result.name)).toEqual([
      ...NAMES.slice(0, 12),
      "the repository can be read",
      "a write is refused",
    ]);
  });

  it("fails when the repository is not the one that was asked for", async () => {
    const base = (await startFakeGitHub()).config.repository;
    await fake?.close();
    const { report } = await run({
      repository: { ...base, name: "other", full_name: `${OWNER}/other` },
    });
    expect(failed(report)).toEqual(["the repository can be read"]);
  });

  it("skips the download when the commit cannot be read", async () => {
    const { report, server } = await run({
      failRoutes: { [`GET /repos/${OWNER}/${REPOSITORY}/commits/main`]: 404 },
    });
    expect(failed(report)).toEqual(["the latest commit can be read"]);
    expect(server.downloads()).toHaveLength(0);
    expect(namesOf(report)).not.toContain("the download can be unpacked");
  });

  it("fails, with the reason, when the download is sent somewhere that is not allowed", async () => {
    const { report, server } = await run({ tarballLocation: () => "https://evil.example.com/x" });
    expect(failed(report)).toEqual(["the repository can be downloaded"]);
    expect(detail(report, "the repository can be downloaded")).toBe("redirect_refused");
    expect(server.downloads()).toHaveLength(0);
    expect(formatReport(report)).not.toContain("evil.example.com");
  });

  it("fails when the download is empty, and says that there is nothing to unpack", async () => {
    const { report } = await run({ tarball: Buffer.alloc(0) });
    expect(failed(report)).toEqual([
      "the repository can be downloaded",
      "the download can be unpacked",
    ]);
    expect(detail(report, "the download can be unpacked")).toBe("corrupt");
  });

  it("fails when the download is larger than the limit, and passes at exactly the limit", async () => {
    const size = repositoryArchive().length;
    const { report: over, workspace } = await run({}, { maxDownloadBytes: size - 1 });
    // Only the download is said to have failed: what was unpacked of it had nothing wrong.
    expect(failed(over)).toEqual(["the repository can be downloaded"]);
    expect(detail(over, "the repository can be downloaded")).toBe("download_too_large");
    expect(namesOf(over)).not.toContain("the download can be unpacked");
    expect(await readdir(workspace)).toEqual([]);
    await fake?.close();
    const { report: exact } = await run({}, { maxDownloadBytes: size });
    expect(failed(exact)).toEqual([]);
  });

  it("reports several failures at once, not only the first", async () => {
    const { report } = await run({
      app: { id: 4242, name: "x", permissions: { contents: "write" }, events: ["push"] },
      blobStatus: 201,
    });
    expect(failed(report)).toEqual([
      "the app can only read contents",
      "the app has no webhook events",
      "a write is refused",
    ]);
  });
});

const namesOf = (report: CheckReport): string[] => report.results.map((result) => result.name);

/**
 * Whether a bad archive is refused while it is being given or only when it ends depends on how the
 * decompressor has got on by then, so a test does not say which: the unpacking is what is said to
 * have failed, and if the download is said to have failed too it is because the unpacking stopped it.
 */
const unpackingFailedAlone = (report: CheckReport): void => {
  expect(failed(report).filter((name) => name !== "the repository can be downloaded")).toEqual([
    "the download can be unpacked",
  ]);
  if (failed(report).includes("the repository can be downloaded")) {
    expect(detail(report, "the repository can be downloaded")).toBe("sink_failed");
  }
};

describe("the download is unpacked", () => {
  it("is unpacked in a directory that is made for it and is gone when the check ends", async () => {
    const { report, workspace } = await run();
    expect(failed(report)).toEqual([]);
    expect(await readdir(workspace)).toEqual([]);
  });

  it("fails, with the code and nothing of the archive, for a download that is not an archive", async () => {
    const { report, workspace } = await run({ tarball: randomBytes(4096) });
    unpackingFailedAlone(report);
    expect(detail(report, "the download can be unpacked")).toBe("corrupt");
    expect(await readdir(workspace)).toEqual([]);
  });

  it("fails, and names nothing from the archive, for an archive that would write outside its directory", async () => {
    const hostile = tarball([{ name: "top/../../SECRET-NAME/escape.txt", content: "x" }]);
    const { report, workspace } = await run({ tarball: hostile });
    unpackingFailedAlone(report);
    expect(detail(report, "the download can be unpacked")).toBe("unsafe_path");
    expect(formatReport(report)).not.toContain("SECRET");
    expect(await readdir(workspace)).toEqual([]);
  });

  it("fails, with the download passing, for an archive that is cut short", async () => {
    const whole = repositoryArchive();
    const { report, workspace } = await run({ tarball: whole.subarray(0, whole.length - 10) });
    expect(failed(report)).toEqual(["the download can be unpacked"]);
    expect(detail(report, "the download can be unpacked")).toBe("corrupt");
    expect(await readdir(workspace)).toEqual([]);
  });

  it("fails for an archive with no file in it, and says how many it had", async () => {
    const { report } = await run({ tarball: tarball([{ name: "top/", type: "directory" }]) });
    expect(failed(report)).toEqual(["the download can be unpacked"]);
    expect(detail(report, "the download can be unpacked")).toBe(
      "files 0, directories 0, content 0 bytes, copy removed",
    );
  });

  it("fails, and still downloads, when there is nowhere to unpack", async () => {
    const { report, server } = await run(
      {},
      { unpackRoot: (workspace) => join(workspace, "does-not-exist") },
    );
    expect(failed(report)).toEqual(["the download can be unpacked"]);
    expect(detail(report, "the download can be unpacked")).toBe("unexpected_error");
    expect(detail(report, "the repository can be downloaded")).toMatch(/ bytes, sha256 /);
    expect(server.downloads()).toHaveLength(1);
    // It is reported where the unpacking would have been, before the write is tried.
    expect(namesOf(report).slice(-3)).toEqual([
      "the download can be unpacked",
      "the repository can be downloaded",
      "a write is refused",
    ]);
  });
});

describe("readsContentsOnly", () => {
  it.each([
    [{ contents: "read" }, true],
    [{ contents: "read", metadata: "read" }, true],
    [{ metadata: "read" }, false],
    [{}, false],
    [{ contents: "write" }, false],
    [{ contents: "read", metadata: "write" }, false],
    [{ contents: "read", issues: "read" }, false],
    [{ contents: "read", metadata: "read", pull_requests: "read" }, false],
    [{ contents: "admin", metadata: "read" }, false],
  ])("says %j is %s", (permissions, expected) => {
    expect(readsContentsOnly(permissions)).toBe(expected);
  });
});

describe("formatReport", () => {
  it("marks each line ok or FAIL and ends with the outcome", () => {
    const text = formatReport({
      ok: false,
      results: [
        { name: "one", ok: true, detail: "fine" },
        { name: "two", ok: false, detail: "broken" },
      ],
    });
    expect(text.split("\n")).toEqual([
      "ok    one: fine",
      "FAIL  two: broken",
      "Some checks failed.",
    ]);
    expect(
      formatReport({ ok: true, results: [{ name: "one", ok: true, detail: "fine" }] }),
    ).toMatch(/All checks passed\.$/);
  });
});
