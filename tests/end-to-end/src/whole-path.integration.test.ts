import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadAnalysisWorkerConfig,
  startAnalysisWorker,
  type StartOptions,
} from "@codemugs/analysis-worker";
import { appServices, buildApp, createDatabaseServices, type BuiltApp } from "@codemugs/api";
import { createOrganisation, createProject, issueApiKey } from "@codemugs/auth";
import { loadApiConfig, Secret } from "@codemugs/configuration";
import { createLogger } from "@codemugs/logging";
import { createPool, type Pool } from "@codemugs/storage";
import { adminDatabaseUrl, createTestDatabase, type TestDatabase } from "@codemugs/storage/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { archiveOfDirectory, standInSandbox, throwawayPrivateKey } from "./support.js";

/**
 * The first slice, in one test: a request to the API connects a repository and asks for it to be
 * analysed, the process that analyses repositories takes the job, downloads the repository (from a
 * stand-in for GitHub that serves this repository's demo shop as an archive), has it analysed, and
 * stores the graph, and the API then serves that graph back, and only to the project that it belongs
 * to. Everything between is the real code, over a real database.
 *
 * It runs twice. With a **real sandbox**, the analyser runs in a docker container with no network,
 * as it does for a customer. That needs a docker daemon and the image `CODEMUGS_TEST_NODE_IMAGE`
 * (a Node image pinned by digest); without them it is skipped, and in CI, which sets
 * `REQUIRE_DOCKER_TESTS`, a missing daemon or image fails the run. With a **stand-in sandbox**, the
 * same command runs on this machine with no isolation, over a repository of ours: that shows the
 * path and nothing of isolation, and it is what runs where there is no docker.
 *
 * **What this shows and what it does not.** It shows that the pieces fit: that what the API queues
 * is what the process takes, that the installation of the connection (and nothing else) is what
 * GitHub is asked about, that the graph that comes back is the repository's, that no source text is
 * in it, and that another project and another organisation cannot read it. It does not show GitHub
 * itself (a stand-in serves the archive), a private repository, a large one, the time that a real
 * repository takes, or that isolation holds: release gate 8 is not started, and nothing is
 * switched on for a customer.
 */

const image = process.env["CODEMUGS_TEST_NODE_IMAGE"];
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const INSTALLATION = 4242;
const SYSTEM = { type: "system" } as const;

function succeeds(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}
const dockerUsable = image !== undefined && succeeds("docker", ["image", "inspect", image]);

interface Flavour {
  readonly name: string;
  readonly usable: boolean;
  readonly required: boolean;
  readonly sandbox: "docker" | "stand-in";
}

const flavours: Flavour[] = [
  {
    name: "a real sandbox",
    usable: dockerUsable,
    required: process.env["REQUIRE_DOCKER_TESTS"] === "true",
    sandbox: "docker",
  },
  { name: "a stand-in sandbox", usable: true, required: false, sandbox: "stand-in" },
];

interface Body<T> {
  statusCode: number;
  json: () => T;
  body: string;
}
interface RunBody {
  run: {
    id: string;
    projectId: string;
    revision: string;
    nodes: number;
    edges: number;
    digest: string;
  };
}
interface NodesBody {
  nodes: Array<{ id: number; kind: string; key: string; attributes: Record<string, unknown> }>;
  next?: number;
}
interface AnalysisBody {
  id: string;
  status: string;
  failureCode?: string;
}
interface ErrorBody {
  error: { code: string };
}

for (const flavour of flavours) {
  const suite =
    adminDatabaseUrl() === undefined || !(flavour.usable || flavour.required)
      ? describe.skip
      : describe;

  suite(`the whole path, with ${flavour.name}`, () => {
    const cleanup: Array<() => Promise<void>> = [];
    let built: BuiltApp;
    let admin: Pool;
    let keys: { writer: string; reader: string; sibling: string; foreign: string };
    let organisationId: string;
    let projectId: string;
    let workspace: string;
    const lines: string[] = [];
    const githubCalls: { opened: Array<[number, string]>; commits: string[]; downloads: string[] } =
      {
        opened: [],
        commits: [],
        downloads: [],
      };

    // What the test found, for the tests below to look at.
    let before: {
      graph: Body<ErrorBody>;
      analysisGraph: Body<ErrorBody>;
      status: Body<AnalysisBody>;
    };
    let first: string;
    let second: string;
    let archiveBytes: number;

    const call = (key: string, method: "GET" | "POST", url: string, payload?: unknown) =>
      built.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
    const get = <T>(key: string, url: string): Promise<Body<T>> => call(key, "GET", url);

    async function until(
      description: string,
      check: () => Promise<boolean>,
      ms: number,
    ): Promise<void> {
      const deadline = Date.now() + ms;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    async function analyse(): Promise<string> {
      const asked = await call(keys.writer, "POST", "/v1/analyses", { ref: "main" });
      expect(asked.statusCode).toBe(202);
      return asked.json<{ id: string }>().id;
    }

    /** Waits for the analysis to succeed, and stops at once if it fails, with the code it failed with. */
    async function succeeded(id: string): Promise<void> {
      await until(
        "the analysis to succeed",
        async () => {
          const state = (await get<AnalysisBody>(keys.reader, `/v1/analyses/${id}`)).json();
          if (state.status === "failed") {
            throw new Error(`the analysis failed with ${state.failureCode ?? "no code"}`);
          }
          return state.status === "succeeded";
        },
        170_000,
      );
    }

    beforeAll(async () => {
      if (!flavour.usable) {
        throw new Error(
          "the whole-path test with a real sandbox is required but there is no usable docker daemon, or the image CODEMUGS_TEST_NODE_IMAGE is not on this host",
        );
      }
      const database: TestDatabase = await createTestDatabase();
      cleanup.unshift(() => database.drop());
      const seed = createPool({ connectionString: database.appUrl, maxConnections: 2 });
      cleanup.unshift(() => seed.end());
      admin = createPool({ connectionString: database.adminUrl, maxConnections: 2 });
      cleanup.unshift(() => admin.end());
      workspace = await realpath(await mkdtemp(join(tmpdir(), "whole-path-")));
      cleanup.unshift(() => rm(workspace, { recursive: true, force: true }));

      // The tenants: an organisation with two projects, and another organisation.
      organisationId = (await createOrganisation(seed, { name: "Acme" })).id;
      const other = (await createOrganisation(seed, { name: "Other" })).id;
      projectId = (await createProject(seed, organisationId, { name: "shop", actor: SYSTEM })).id;
      const sibling = (
        await createProject(seed, organisationId, { name: "sibling", actor: SYSTEM })
      ).id;
      const foreign = (await createProject(seed, other, { name: "foreign", actor: SYSTEM })).id;
      const key = async (
        org: string,
        project: string,
        scopes: Array<"analysis:read" | "analysis:write">,
      ) => (await issueApiKey(seed, org, project, { name: "key", actor: SYSTEM, scopes })).key;
      keys = {
        writer: await key(organisationId, projectId, ["analysis:write"]),
        reader: await key(organisationId, projectId, ["analysis:read"]),
        sibling: await key(organisationId, sibling, ["analysis:read"]),
        foreign: await key(other, foreign, ["analysis:read"]),
      };
      // What an operator does: binds an installation of the GitHub App to the organisation.
      await admin.query(
        "INSERT INTO github_installations (organisation_id, installation_id) VALUES ($1, $2)",
        [organisationId, INSTALLATION],
      );

      // The API, as main.ts wires it, over the same database.
      const services = createDatabaseServices(new Secret(database.appUrl), {
        onError: () => undefined,
      });
      built = await buildApp({
        config: loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
        ...appServices(services),
      });
      cleanup.unshift(async () => {
        await built.app.close();
        await services.close().catch(() => undefined);
      });

      // 1. The project says which repository it is, and asks for it to be analysed.
      const connected = await call(keys.writer, "POST", "/v1/repository", {
        installationId: INSTALLATION,
        owner: "acme",
        name: "shop",
      });
      expect(connected.statusCode).toBe(201);
      first = await analyse();

      // 2. Nothing is analysed yet, because no process has taken the job.
      before = {
        graph: await get(keys.reader, "/v1/graph"),
        analysisGraph: await get(keys.reader, `/v1/analyses/${first}/graph`),
        status: await get(keys.reader, `/v1/analyses/${first}`),
      };

      // 3. The process that analyses repositories starts, with a stand-in for GitHub that serves the
      // demo shop as an archive, and the sandbox of this flavour. It checks the roles, the key and the
      // sandbox before it takes a job.
      const archive = await archiveOfDirectory(join(repositoryRoot, "tests/demo-shop"));
      archiveBytes = archive.length;
      const config = loadAnalysisWorkerConfig({
        DATABASE_URL: database.appUrl,
        DISPATCHER_DATABASE_URL: database.dispatcherUrl,
        CODEMUGS_GITHUB_APP_ID: "5776596",
        CODEMUGS_GITHUB_APP_CLIENT_ID: "Iv23lipC397du816RxiY",
        CODEMUGS_GITHUB_APP_PRIVATE_KEY: throwawayPrivateKey(),
        ANALYSIS_SANDBOX_DRIVER: "docker",
        ANALYSIS_SANDBOX_MINIMUM_ISOLATION: "hardened-container",
        ANALYSIS_SANDBOX_IMAGE:
          flavour.sandbox === "docker" && image !== undefined
            ? image
            : `docker.io/library/node@sha256:${"a".repeat(64)}`,
        ANALYSIS_WORKSPACE_ROOT: workspace,
        WORKER_POLL_INTERVAL_MS: "50",
      });
      const github: StartOptions["openRepository"] = (installationId, name) => {
        githubCalls.opened.push([installationId, name]);
        return Promise.resolve({
          getCommitId: (owner, repository, ref) => {
            githubCalls.commits.push(`${owner}/${repository}@${ref}`);
            return Promise.resolve(COMMIT);
          },
          downloadTarball: async (owner, repository, ref, options) => {
            githubCalls.downloads.push(`${owner}/${repository}@${ref}`);
            for (let at = 0; at < archive.length; at += 16_384) {
              await options.onChunk?.(archive.subarray(at, at + 16_384));
            }
            return {
              bytes: archive.length,
              sha256: createHash("sha256").update(archive).digest("hex"),
            };
          },
        });
      };
      const worker = await startAnalysisWorker({
        config,
        logger: createLogger("debug", (line) => lines.push(line)),
        openRepository: github,
        ...(flavour.sandbox === "stand-in" ? { driver: standInSandbox() } : {}),
      });
      cleanup.unshift(() => worker.stop());

      // 4. The analysis succeeds, and a second one, of the same commit, does too.
      await succeeded(first);
      second = await analyse();
      await succeeded(second);
    }, 420_000);

    afterAll(async () => {
      for (const step of cleanup) await step().catch(() => undefined);
    });

    it("has no graph for a repository that nothing has analysed yet, and says that the analysis is queued", () => {
      expect(before.graph.statusCode).toBe(404);
      expect(before.graph.json().error.code).toBe("graph_not_found");
      expect(before.analysisGraph.statusCode).toBe(404);
      expect(before.analysisGraph.json().error.code).toBe("graph_not_found");
      expect(before.status.json().status).toBe("queued");
    });

    it("asks GitHub about the repository of the connection, with the installation that the operator bound, and nothing else", () => {
      expect(
        new Set(
          githubCalls.opened.map(([installation, name]) => `${String(installation)} ${name}`),
        ),
      ).toEqual(new Set([`${String(INSTALLATION)} shop`]));
      expect(new Set(githubCalls.commits)).toEqual(new Set(["acme/shop@main"]));
      // What is downloaded is the commit that the ref resolved to, not the ref: the analysis is of one
      // commit even if the branch moves while it runs.
      expect(new Set(githubCalls.downloads)).toEqual(new Set([`acme/shop@${COMMIT}`]));
    });

    it("serves the graph that the analysis stored: the latest is the second run, and each is of the commit that was analysed", async () => {
      const latest = await get<RunBody>(keys.reader, "/v1/graph");
      expect(latest.statusCode).toBe(200);
      expect(latest.json().run).toMatchObject({ id: second, projectId, revision: COMMIT });
      const earlier = await get<RunBody>(keys.reader, `/v1/analyses/${first}/graph`);
      expect(earlier.json().run).toMatchObject({ id: first, projectId, revision: COMMIT });
      // The same commit gives the same graph.
      expect(latest.json().run.digest).toBe(earlier.json().run.digest);
      expect(latest.json().run.nodes).toBe(earlier.json().run.nodes);
      expect(latest.json().run.edges).toBe(earlier.json().run.edges);
      expect(latest.json().run.nodes).toBeGreaterThan(15);
      expect(latest.json().run.edges).toBeGreaterThan(15);
    });

    it("has, in every page of the nodes, as many as the run says, and the routes, the variable and the files of the shop", async () => {
      const run = (await get<RunBody>(keys.reader, `/v1/analyses/${second}/graph`)).json().run;
      const all: NodesBody["nodes"] = [];
      let after: number | undefined;
      for (;;) {
        const page = await get<NodesBody>(
          keys.reader,
          `/v1/analyses/${second}/nodes?limit=7${after === undefined ? "" : `&after=${String(after)}`}`,
        );
        expect(page.statusCode).toBe(200);
        all.push(...page.json().nodes);
        after = page.json().next;
        if (after === undefined) break;
      }
      expect(all).toHaveLength(run.nodes);
      expect(new Set(all.map((node) => node.id)).size).toBe(all.length);
      const keysOf = (kind: string): string[] =>
        all.filter((node) => node.kind === kind).map((node) => node.key);
      expect(keysOf("route")).toEqual(
        expect.arrayContaining(["GET /health", "GET /products", "POST /orders"]),
      );
      expect(keysOf("env_var")).toContain("PORT");
      expect(keysOf("file")).toEqual(
        expect.arrayContaining([
          "src/main.ts",
          "src/server.ts",
          "src/money.ts",
          "src/telemetry.ts",
        ]),
      );
      // The paths are the repository's, with the top directory of the archive gone.
      expect(keysOf("file").every((path) => !path.startsWith("repo-0123abc"))).toBe(true);
    });

    it("answers what a change to a file reaches, and what a file is joined to", async () => {
      const importers = await get<{ files: Array<{ key: string; depth: number }> }>(
        keys.reader,
        `/v1/analyses/${second}/imports?path=src/telemetry.ts&direction=importers&depth=1`,
      );
      expect(importers.statusCode).toBe(200);
      expect(importers.json().files.map((file) => file.key)).toEqual(
        expect.arrayContaining(["src/main.ts", "src/shop.ts"]),
      );
      expect(importers.json().files.every((file) => file.depth === 1)).toBe(true);

      const found = await get<{ node: { id: number; key: string } }>(
        keys.reader,
        `/v1/analyses/${second}/node?kind=file&key=src/server.ts`,
      );
      expect(found.statusCode).toBe(200);
      const near = await get<{
        neighbours: Array<{ edge: { kind: string }; node: { key: string } }>;
      }>(
        keys.reader,
        `/v1/analyses/${second}/nodes/${String(found.json().node.id)}/neighbours?edge=imports`,
      );
      expect(near.json().neighbours.map((entry) => entry.node.key)).toEqual(
        expect.arrayContaining(["src/catalog.ts", "src/money.ts", "src/requests.ts"]),
      );
    });

    it("holds facts and never content: no line of the shop's source is anywhere in what the API gives", async () => {
      const everything: string[] = [];
      for (const id of [first, second]) {
        everything.push((await get(keys.reader, `/v1/analyses/${id}/graph`)).body);
        for (let after = -1; ;) {
          const page = await get<NodesBody>(
            keys.reader,
            `/v1/analyses/${id}/nodes?limit=1000${after < 0 ? "" : `&after=${String(after)}`}`,
          );
          everything.push(page.body);
          const next = page.json().next;
          if (next === undefined) break;
          after = next;
        }
      }
      const text = everything.join("\n");
      // Strings that are in the shop's source and are neither a path, a name nor a route.
      for (const content of ["body_too_large", "invalid_json", "http://shop.invalid"]) {
        expect(text).not.toContain(content);
      }
    });

    it("shows the graph to the project that it belongs to and to no other: not another project of the organisation, not another organisation", async () => {
      const urls = [
        "/v1/graph",
        `/v1/analyses/${second}/graph`,
        `/v1/analyses/${second}/nodes`,
        `/v1/analyses/${second}/node?kind=file&key=src/main.ts`,
        `/v1/analyses/${second}/nodes/0/neighbours`,
        `/v1/analyses/${second}/imports?path=src/main.ts&direction=imports`,
      ];
      for (const key of [keys.sibling, keys.foreign]) {
        const answers = await Promise.all(urls.map((url) => get<ErrorBody>(key, url)));
        for (const answer of answers) {
          expect(answer.statusCode).toBe(404);
          expect(answer.json().error.code).toBe("graph_not_found");
          expect(answer.body).not.toContain("src/main.ts");
        }
      }
    });

    it("keeps no secret and no source in what the process logged, and leaves nothing of the repository behind", async () => {
      const logged = lines.join("\n");
      expect(logged).toContain("worker started");
      expect(logged).not.toContain("PRIVATE KEY");
      expect(logged).not.toContain("body_too_large");
      expect(logged).not.toContain("postgres://");
      // The unpacked and staged copies are removed, whatever happened.
      const left = (await readdir(workspace)).filter(
        (name) => name.startsWith("analysis-") || name.startsWith("checkout-"),
      );
      expect(left).toEqual([]);
      expect(archiveBytes).toBeGreaterThan(1_000);
    });

    it("records that the analysis was asked for, and by whom", async () => {
      const { rows } = await admin.query<{ n: string }>(
        "SELECT count(*) AS n FROM analysis_requests WHERE organisation_id = $1 AND project_id = $2",
        [organisationId, projectId],
      );
      expect(Number(rows[0]?.n)).toBe(2);
    });
  });
}
