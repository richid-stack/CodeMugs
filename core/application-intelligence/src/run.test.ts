import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SandboxError, type SandboxDriver, type SandboxResult } from "@codemugs/sandbox-manager";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyse } from "./analyse.js";
import { AnalysisError } from "./errors.js";
import { parseRepositoryFacts } from "./facts.js";
import { ANALYSIS_SANDBOX, analyseInSandbox, type AnalyseInSandboxOptions } from "./run.js";
import { directorySource } from "./source.js";
import { exited, fakeDriver, IMAGE, standIn } from "./test-drivers.js";

let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "codemugs-run-"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

let counter = 0;
async function directory(files: Record<string, string> = {}): Promise<string> {
  counter += 1;
  const root = join(base, `d${String(counter)}`);
  await mkdir(root, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

async function options(
  driver: SandboxDriver,
  files: Record<string, string> = { "a.ts": 'import x from "zod";\n' },
  overrides: Partial<AnalyseInSandboxOptions> = {},
): Promise<AnalyseInSandboxOptions & { workspaceRoot: string }> {
  return {
    driver,
    workspaceRoot: await directory(),
    image: IMAGE,
    minimumIsolation: "hardened-container",
    repository: await directory(files),
    ...overrides,
  };
}

const analysisDirectories = async (workspaceRoot: string): Promise<string[]> =>
  (await readdir(workspaceRoot)).filter((name) => name.startsWith("analysis-"));

async function failure(promise: Promise<unknown>): Promise<AnalysisError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AnalysisError) return error;
    throw error;
  }
  throw new Error("the analysis gave facts");
}

describe("analyseInSandbox, from the staging to the facts", () => {
  it("gives the facts that the analyser gives for the same repository", async () => {
    const settings = await options(standIn(), {
      "package.json": '{"name":"x","dependencies":{"express":"^5.0.0"}}',
      "src/a.ts":
        'import express from "express";\nconst app = express();\napp.get("/health", h);\nprocess.env.PORT;\n',
    });
    const facts = await analyseInSandbox(settings);
    expect(facts).toEqual(await analyse(directorySource(settings.repository)));
    expect(facts.routes.map((route) => route.path)).toEqual(["/health"]);
    expect(await analysisDirectories(settings.workspaceRoot)).toEqual([]);
  }, 60_000);
});

describe("analyseInSandbox, what the sandbox is asked", () => {
  it("asks for the analyser, the staged repository and a policy that is written here", async () => {
    const driver = fakeDriver(() => exited({ exitCode: 1 }));
    const settings = await options(driver);
    await failure(analyseInSandbox(settings));
    expect(driver.requests).toHaveLength(1);
    const [request] = driver.requests;
    expect(request?.command).toEqual([
      "node",
      `--max-old-space-size=${String(ANALYSIS_SANDBOX.heapMb)}`,
      "/workspace/tool/dist/main.js",
      "/workspace/repo",
    ]);
    expect(request?.policy).toEqual({
      image: IMAGE,
      limits: ANALYSIS_SANDBOX.limits,
      mounts: {
        source: { containerPath: "/workspace" },
        scratch: { containerPath: "/scratch", sizeMb: 16 },
      },
      network: { mode: "none" },
    });
    expect(request?.sourceDirectory?.startsWith(`${settings.workspaceRoot}/analysis-`)).toBe(true);
  });

  it("shows the sandbox a directory that holds the tool and the repository, while it runs", async () => {
    let seen: string[] = [];
    const driver = fakeDriver(async (request) => {
      const root = request.sourceDirectory ?? "";
      seen = (await readdir(root)).sort();
      expect(existsSync(join(root, "tool/dist/main.js"))).toBe(true);
      expect(await readFile(join(root, "repo/a.ts"), "utf8")).toContain("zod");
      return exited({ exitCode: 1 });
    });
    const settings = await options(driver);
    await failure(analyseInSandbox(settings));
    expect(seen).toEqual(["repo", "tool"]);
  });

  it("removes the staged directory when the run ends, however it ends", async () => {
    const outcomes: (() => Promise<SandboxResult>)[] = [
      () => Promise.resolve(exited({ exitCode: 1 })),
      () => Promise.resolve(exited({ outcome: "timed_out", exitCode: null })),
      () => Promise.reject(new SandboxError("run_failed")),
      () => Promise.reject(new Error("anything")),
    ];
    for (const outcome of outcomes) {
      const settings = await options(fakeDriver(outcome));
      await expect(analyseInSandbox(settings)).rejects.toBeInstanceOf(AnalysisError);
      expect(await analysisDirectories(settings.workspaceRoot)).toEqual([]);
    }
  });

  it("takes lower limits for a test, and the sandbox manager refuses what its policy does not accept", async () => {
    const driver = fakeDriver(() => exited({ exitCode: 1 }));
    await failure(
      analyseInSandbox(
        await options(driver, undefined, { limits: { wallClockSeconds: 5, outputBytes: 100 } }),
      ),
    );
    expect(driver.requests[0]?.policy.limits).toEqual({
      ...ANALYSIS_SANDBOX.limits,
      wallClockSeconds: 5,
      outputBytes: 100,
    });
    const refusing = fakeDriver(() => exited());
    const error = await failure(
      analyseInSandbox(await options(refusing, undefined, { limits: { memoryMb: 1 } })),
    );
    expect(error.code).toBe("sandbox_failed");
    expect(refusing.requests).toEqual([]);
  });

  it("asks for an image that is pinned by digest, and takes no other", async () => {
    const driver = fakeDriver(() => exited());
    const settings = await options(driver, undefined, {
      image: "docker.io/library/node:22-alpine",
    });
    const error = await failure(analyseInSandbox(settings));
    expect(error.code).toBe("sandbox_failed");
    expect(driver.requests).toEqual([]);
    expect(await analysisDirectories(settings.workspaceRoot)).toEqual([]);
  });

  it("analyses two repositories at once without mixing them", async () => {
    const driver = standIn();
    const [one, two] = await Promise.all([
      options(driver, { "one.ts": 'import a from "one-package";\n' }),
      options(driver, { "two.ts": 'import a from "two-package";\n' }),
    ]);
    const [first, second] = await Promise.all([analyseInSandbox(one), analyseInSandbox(two)]);
    expect(first.files.map((file) => file.path)).toEqual(["one.ts"]);
    expect(second.files.map((file) => file.path)).toEqual(["two.ts"]);
  }, 60_000);
});

describe("analyseInSandbox, before it runs anything", () => {
  it("does not stage or run when the driver is not available, or does not answer", async () => {
    for (const availability of [
      () => Promise.resolve({ available: false as const, reason: "SECRET-REASON" }),
      () => Promise.reject(new Error("SECRET-ERROR")),
    ]) {
      const driver = fakeDriver(() => exited(), { availability });
      const settings = await options(driver);
      const error = await failure(analyseInSandbox(settings));
      expect(error.code).toBe("sandbox_unavailable");
      expect(error.message).not.toContain("SECRET");
      expect(driver.requests).toEqual([]);
      expect(await analysisDirectories(settings.workspaceRoot)).toEqual([]);
    }
  });

  it("does not stage or run on a driver that isolates less than is asked", async () => {
    const driver = fakeDriver(() => exited(), { isolation: "hardened-container" });
    const settings = await options(driver, undefined, { minimumIsolation: "gvisor" });
    expect((await failure(analyseInSandbox(settings))).code).toBe("sandbox_too_weak");
    expect(driver.requests).toEqual([]);
    expect(await analysisDirectories(settings.workspaceRoot)).toEqual([]);
  });

  it("runs on a driver that isolates as much as is asked, or more", async () => {
    for (const [isolation, minimum] of [
      ["gvisor", "gvisor"],
      ["microvm", "gvisor"],
      ["gvisor", "hardened-container"],
    ] as const) {
      const driver = fakeDriver(() => exited({ exitCode: 1 }), { isolation });
      const settings = await options(driver, undefined, { minimumIsolation: minimum });
      expect((await failure(analyseInSandbox(settings))).code).toBe("analysis_failed");
      expect(driver.requests).toHaveLength(1);
    }
  });

  it("says that a repository that cannot be read cannot, before it asks the sandbox", async () => {
    const driver = fakeDriver(() => exited());
    const settings = await options(driver, undefined, { repository: join(base, "does-not-exist") });
    expect((await failure(analyseInSandbox(settings))).code).toBe("repository_unreadable");
    expect(driver.requests).toEqual([]);
  });
});

describe("analyseInSandbox, how an ended run is read", () => {
  async function code(result: SandboxResult | Error): Promise<AnalysisError> {
    const driver = fakeDriver(() => (result instanceof Error ? Promise.reject(result) : result));
    return failure(analyseInSandbox(await options(driver)));
  }

  it.each([
    ["timed out", exited({ outcome: "timed_out", exitCode: null }), "analysis_timed_out"],
    [
      "out of memory",
      exited({ outcome: "out_of_memory", exitCode: 137 }),
      "analysis_out_of_memory",
    ],
    [
      "over the output limit",
      exited({ outcome: "output_limit_exceeded", exitCode: null }),
      "analysis_output_too_large",
    ],
    ["exited with 1", exited({ exitCode: 1 }), "analysis_failed"],
    ["exited with 2", exited({ exitCode: 2 }), "analysis_failed"],
    [
      "exited with 137 and no outcome of the driver's",
      exited({ exitCode: 137 }),
      "analysis_failed",
    ],
    ["not exited with a code", exited({ exitCode: null }), "analysis_failed"],
    [
      "output that was cut",
      exited({ stdout: "{}", stdoutTruncated: true }),
      "analysis_output_too_large",
    ],
    ["nothing printed", exited({ stdout: "" }), "analysis_output_rejected"],
    ["something that is not JSON", exited({ stdout: "not json" }), "analysis_output_rejected"],
    ["JSON that is not facts", exited({ stdout: "{}" }), "analysis_output_rejected"],
    ["a list", exited({ stdout: "[]" }), "analysis_output_rejected"],
  ])("%s is %s", async (_name, result, expected) => {
    expect((await code(result)).code).toBe(expected);
  });

  it("refuses facts that have a key that the schema does not know", async () => {
    const facts = JSON.stringify({
      ...(await analyse(directorySource(await directory({ "a.ts": "x" })))),
      extra: "SECRET-EXTRA",
    });
    const error = await code(exited({ stdout: facts }));
    expect(error.code).toBe("analysis_output_rejected");
    expect(error.message).not.toContain("SECRET");
  });

  it("accepts facts that the schema accepts, with a line end after them, and ignores what went to stderr", async () => {
    const facts = await analyse(
      directorySource(await directory({ "a.ts": "import a from 'zod';" })),
    );
    const driver = fakeDriver(() =>
      exited({ stdout: `${JSON.stringify(facts)}\n`, stderr: "(node) a warning" }),
    );
    expect(await analyseInSandbox(await options(driver))).toEqual(
      parseRepositoryFacts(JSON.stringify(facts)),
    );
  });

  it("turns a driver that says it is not available into that, and any other failure into one code", async () => {
    expect((await code(new SandboxError("unavailable"))).code).toBe("sandbox_unavailable");
    for (const failureOfTheDriver of [
      new SandboxError("start_failed"),
      new SandboxError("run_failed"),
      new SandboxError("cleanup_failed"),
      new SandboxError("source_not_allowed"),
      new Error("anything at all"),
      // Only the sandbox manager's own error can say that the sandbox is not available.
      Object.assign(new Error("a look-alike"), { code: "unavailable" }),
    ]) {
      expect((await code(failureOfTheDriver)).code).toBe("sandbox_failed");
    }
  });

  it("never puts what the run printed, or what the driver said, in what it throws", async () => {
    const results: (SandboxResult | Error)[] = [
      exited({ exitCode: 1, stdout: "SECRET-STDOUT", stderr: "SECRET-STDERR" }),
      exited({
        outcome: "timed_out",
        exitCode: null,
        stdout: "SECRET-STDOUT",
        stderr: "SECRET-STDERR",
      }),
      exited({ outcome: "out_of_memory", stdout: "SECRET-STDOUT" }),
      exited({ stdout: "SECRET-STDOUT" }),
      exited({ stdout: '{"SECRET-KEY":1}' }),
      new Error("SECRET-DRIVER-TEXT"),
    ];
    for (const result of results) {
      const error = await code(result);
      expect(error).toBeInstanceOf(AnalysisError);
      const everything = [
        error.message,
        error.name,
        error.stack ?? "",
        JSON.stringify(error),
        String(error),
      ].join("\n");
      expect(everything).not.toContain("SECRET");
      expect(error.cause).toBeUndefined();
    }
  });
});

describe("ANALYSIS_SANDBOX", () => {
  it("is frozen, leaves the time for the analyser to stop by itself, and keeps the heap below the memory", () => {
    expect(Object.isFrozen(ANALYSIS_SANDBOX)).toBe(true);
    expect(Object.isFrozen(ANALYSIS_SANDBOX.limits)).toBe(true);
    expect(ANALYSIS_SANDBOX.limits.wallClockSeconds * 1000).toBeGreaterThan(120_000);
    expect(ANALYSIS_SANDBOX.heapMb).toBeLessThan(ANALYSIS_SANDBOX.limits.memoryMb);
  });
});
