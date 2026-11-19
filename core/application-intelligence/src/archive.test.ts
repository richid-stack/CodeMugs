import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { inPieces, tar, tarball } from "@codemugs/archive/testing";
import { SandboxError, type SandboxDriver, type SandboxResult } from "@codemugs/sandbox-manager";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyseArchive, type AnalyseArchiveOptions, type ArchiveSink } from "./archive.js";
import { AnalysisError } from "./errors.js";
import { analyse } from "./analyse.js";
import { analyseInSandbox } from "./run.js";
import { directorySource } from "./source.js";
import { archiveOfDirectory, exited, fakeDriver, IMAGE, standIn } from "./test-drivers.js";

let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "codemugs-archive-"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const TOP = "repo-0123abc";
const FILES = {
  "package.json": '{"name":"x","dependencies":{"express":"^5.0.0"}}',
  "src/a.ts":
    'import express from "express";\nconst app = express();\napp.get("/health", h);\nprocess.env.PORT;\n',
};

/** A repository's archive the way GitHub makes one: every path under one top directory. */
const archiveOf = (files: Record<string, string> = FILES): Buffer =>
  tarball(Object.entries(files).map(([name, content]) => ({ name: `${TOP}/${name}`, content })));

/** The source of an archive that gives these bytes in these pieces, as a download does. */
const giving =
  (bytes: Buffer, pieces: readonly number[] = []): AnalyseArchiveOptions["archive"] =>
  async (sink: ArchiveSink) => {
    for (const part of pieces.length === 0 ? [bytes] : inPieces(bytes, pieces)) await sink(part);
  };

let counter = 0;
async function directory(files: Record<string, string> = {}): Promise<string> {
  counter += 1;
  const root = join(base, `d${String(counter)}`);
  await mkdir(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

async function options(
  driver: SandboxDriver,
  archive: AnalyseArchiveOptions["archive"],
  overrides: Partial<AnalyseArchiveOptions> = {},
): Promise<AnalyseArchiveOptions & { workspaceRoot: string }> {
  return {
    driver,
    workspaceRoot: await directory(),
    image: IMAGE,
    minimumIsolation: "hardened-container",
    archive,
    ...overrides,
  };
}

const left = async (workspaceRoot: string): Promise<string[]> => readdir(workspaceRoot);

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the analysis gave facts");
}

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await failure(promise);
  if (!(error instanceof AnalysisError)) throw error;
  return error.code;
}

const never = (): AnalyseArchiveOptions["archive"] => {
  const source = (): Promise<void> => {
    source.asked += 1;
    return Promise.resolve();
  };
  source.asked = 0;
  return source;
};

describe("analyseArchive, from the bytes to the facts", () => {
  it("gives the facts that analysing the same files as a directory gives", async () => {
    const driver = standIn();
    const fromArchive = await analyseArchive(await options(driver, giving(archiveOf())));
    const fromDirectory = await analyseInSandbox({
      driver,
      workspaceRoot: await directory(),
      image: IMAGE,
      minimumIsolation: "hardened-container",
      repository: await directory(FILES),
    });
    expect(fromArchive).toEqual(fromDirectory);
    expect(fromArchive.files.map((file) => file.path)).toEqual(["package.json", "src/a.ts"]);
  }, 60_000);

  it("gives, for an archive of the demo shop, the facts that this process gives for its directory", async () => {
    const shop = fileURLToPath(new URL("../../../tests/demo-shop", import.meta.url));
    const facts = await analyseArchive(
      await options(standIn(), giving(await archiveOfDirectory(shop))),
    );
    expect(facts).toEqual(await analyse(directorySource(shop)));
    expect(facts.routes.map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining(["GET /health", "GET /products", "POST /orders"]),
    );
  }, 60_000);

  it("takes the archive in pieces of any size", async () => {
    const bytes = archiveOf();
    const whole = await analyseArchive(await options(standIn(), giving(bytes)));
    for (const pieces of [[1], [7, 100], [bytes.length - 1]]) {
      expect(await analyseArchive(await options(standIn(), giving(bytes, pieces)))).toEqual(whole);
    }
  }, 60_000);

  it("shows the sandbox the repository without its top directory, under repo/", async () => {
    let seen: { entries: string[]; text: string } | undefined;
    const driver = fakeDriver(async (request) => {
      const root = request.sourceDirectory ?? "";
      seen = {
        entries: (await readdir(join(root, "repo"))).sort(),
        text: await readFile(join(root, "repo", "src", "a.ts"), "utf8"),
      };
      return exited({ exitCode: 1 });
    });
    await failure(analyseArchive(await options(driver, giving(archiveOf()))));
    expect(seen?.entries).toEqual(["package.json", "src"]);
    expect(seen?.text).toContain("express");
  });

  it("asks the sandbox for the image and the limits that it was given", async () => {
    const driver = fakeDriver(() => exited({ exitCode: 1 }));
    await failure(
      analyseArchive(
        await options(driver, giving(archiveOf()), {
          limits: { wallClockSeconds: 5, outputBytes: 100 },
        }),
      ),
    );
    expect(driver.requests).toHaveLength(1);
    expect(driver.requests[0]?.policy.image).toBe(IMAGE);
    expect(driver.requests[0]?.policy.limits.wallClockSeconds).toBe(5);
    expect(driver.requests[0]?.policy.limits.outputBytes).toBe(100);
  });

  it("analyses two archives at once without mixing them", async () => {
    const driver = standIn();
    const [first, second] = await Promise.all([
      options(driver, giving(archiveOf({ "one.ts": 'import a from "one";\n' }))).then(
        analyseArchive,
      ),
      options(driver, giving(archiveOf({ "two.ts": 'import a from "two";\n' }))).then(
        analyseArchive,
      ),
    ]);
    expect(first.files.map((file) => file.path)).toEqual(["one.ts"]);
    expect(second.files.map((file) => file.path)).toEqual(["two.ts"]);
  }, 60_000);
});

describe("analyseArchive, before it takes anything", () => {
  it("does not ask for the archive when the driver is not available, or does not answer", async () => {
    for (const availability of [
      () => Promise.resolve({ available: false as const, reason: "SECRET-REASON" }),
      () => Promise.reject(new Error("SECRET-ERROR")),
    ]) {
      const source = never();
      const driver = fakeDriver(() => exited(), { availability });
      const settings = await options(driver, source);
      const error = await failure(analyseArchive(settings));
      expect(error).toBeInstanceOf(AnalysisError);
      expect((error as AnalysisError).code).toBe("sandbox_unavailable");
      expect((error as AnalysisError).message).not.toContain("SECRET");
      expect(source).toHaveProperty("asked", 0);
      expect(driver.requests).toEqual([]);
      expect(await left(settings.workspaceRoot)).toEqual([]);
    }
  });

  it("does not ask for the archive on a driver that isolates less than is asked", async () => {
    const source = never();
    const driver = fakeDriver(() => exited(), { isolation: "hardened-container" });
    const settings = await options(driver, source, { minimumIsolation: "gvisor" });
    expect(await code(analyseArchive(settings))).toBe("sandbox_too_weak");
    expect(source).toHaveProperty("asked", 0);
    expect(await left(settings.workspaceRoot)).toEqual([]);
  });

  it("says that the sandbox failed, and does not ask for the archive, when there is no workspace", async () => {
    const source = never();
    const settings = await options(
      fakeDriver(() => exited()),
      source,
      { workspaceRoot: join(base, "does-not-exist") },
    );
    expect(await code(analyseArchive(settings))).toBe("sandbox_failed");
    expect(source).toHaveProperty("asked", 0);
  });

  it("says so, and leaves nothing behind, when a limit is not a number that is allowed", async () => {
    const settings = await options(
      fakeDriver(() => exited()),
      giving(archiveOf()),
      { unpackLimits: { maxEntries: -1 } },
    );
    expect(await failure(analyseArchive(settings))).toBeInstanceOf(RangeError);
    expect(await left(settings.workspaceRoot)).toEqual([]);
  });
});

describe("analyseArchive, an archive that is not a repository's", () => {
  const cases: [string, () => Buffer, string, Record<string, number>?][] = [
    ["is not gzip", () => randomBytes(2_048), "repository_unreadable"],
    ["is empty", () => Buffer.alloc(0), "repository_unreadable"],
    ["is cut short", () => archiveOf().subarray(0, -12), "repository_unreadable"],
    [
      "has a path that goes outside",
      () => tarball([{ name: `${TOP}/../../escape.ts`, content: "x" }]),
      "repository_unreadable",
    ],
    [
      "has a path that is absolute",
      () => tarball([{ name: "/etc/passwd", content: "x" }]),
      "repository_unreadable",
    ],
    [
      "has a kind of entry that is refused",
      () => tarball([{ name: `${TOP}/a`, type: "hardlink", linkname: `${TOP}/b` }]),
      "repository_unreadable",
    ],
    [
      "has more entries than the unpacking accepts",
      () => archiveOf({ "a.ts": "1", "b.ts": "2", "c.ts": "3" }),
      "repository_too_large",
      { maxEntries: 2 },
    ],
    [
      "has more content than the unpacking accepts",
      () => archiveOf({ "a.ts": "x".repeat(100) }),
      "repository_too_large",
      { maxContentBytes: 50 },
    ],
    [
      "unpacks to more than the unpacking accepts",
      () => archiveOf({ "a.ts": "x".repeat(100_000) }),
      "repository_too_large",
      { maxDecompressedBytes: 10_000 },
    ],
  ];

  it.each(cases)("says so for an archive that %s", async (_name, make, expected, limits) => {
    const driver = fakeDriver(() => exited());
    const settings = await options(driver, giving(make()), {
      ...(limits === undefined ? {} : { unpackLimits: limits }),
    });
    expect(await code(analyseArchive(settings))).toBe(expected);
    expect(driver.requests).toEqual([]);
    expect(await left(settings.workspaceRoot)).toEqual([]);
  });

  it("does not put a name from the archive in what it throws", async () => {
    const bytes = tarball([{ name: `${TOP}/../SECRET-NAME/${"é".repeat(10)}`, content: "x" }]);
    const error = await failure(
      analyseArchive(
        await options(
          fakeDriver(() => exited()),
          giving(bytes),
        ),
      ),
    );
    expect(error).toBeInstanceOf(AnalysisError);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain("SECRET");
  });

  it("says what the unpacking said, and not what the source made of it, when the source wraps the failure", async () => {
    // The GitHub client turns a sink that threw into an error of its own (`sink_failed`).
    const hostile = tarball([{ name: "/etc/passwd", content: "x" }]);
    const settings = await options(
      fakeDriver(() => exited()),
      async (sink) => {
        try {
          await sink(hostile);
        } catch {
          throw new Error("the sink failed");
        }
      },
    );
    expect(await code(analyseArchive(settings))).toBe("repository_unreadable");
  });

  it("stops at the piece that is refused, and the source is not asked for more", async () => {
    const hostile = tarball([{ name: "/etc/passwd", content: "x" }]);
    let given = 0;
    const settings = await options(
      fakeDriver(() => exited()),
      async (sink) => {
        // A source that keeps going until its sink throws, as the download does.
        for (let index = 0; index < 1_000; index += 1) {
          given += 1;
          await sink(index === 0 ? hostile : Buffer.alloc(64));
        }
      },
    );
    expect(await code(analyseArchive(settings))).toBe("repository_unreadable");
    expect(given).toBeLessThan(1_000);
    expect(await left(settings.workspaceRoot)).toEqual([]);
  });
});

describe("analyseArchive, a source that fails", () => {
  class DownloadFailed extends Error {}

  it("says that the sandbox failed, and not that the repository is bad, for a source that gives no bytes", async () => {
    const settings = await options(
      fakeDriver(() => exited()),
      async (sink) => {
        await sink("not bytes" as unknown as Uint8Array);
      },
    );
    expect(await code(analyseArchive(settings))).toBe("sandbox_failed");
    expect(await left(settings.workspaceRoot)).toEqual([]);
  });

  it("throws what the source threw, as it threw it, and removes what it had unpacked", async () => {
    const thrown = new DownloadFailed("the download failed");
    const settings = await options(
      fakeDriver(() => exited()),
      async (sink) => {
        await sink(archiveOf().subarray(0, 40));
        throw thrown;
      },
    );
    expect(await failure(analyseArchive(settings))).toBe(thrown);
    expect(await left(settings.workspaceRoot)).toEqual([]);
  });

  it("throws what the source threw when it threw before it gave anything", async () => {
    const thrown = new DownloadFailed("the download failed");
    const driver = fakeDriver(() => exited());
    const settings = await options(driver, () => Promise.reject(thrown));
    expect(await failure(analyseArchive(settings))).toBe(thrown);
    expect(driver.requests).toEqual([]);
    expect(await left(settings.workspaceRoot)).toEqual([]);
  });
});

/** What this process has open that is inside the folder: a file that an unpacking left open. */
async function openInside(folder: string): Promise<string[]> {
  const names = await readdir("/proc/self/fd");
  const targets = await Promise.all(
    names.map((name) => readlink(join("/proc/self/fd", name)).catch(() => "")),
  );
  return targets.filter((target) => target.startsWith(folder));
}

describe.skipIf(!existsSync("/proc/self/fd"))(
  "analyseArchive, a file that is half unpacked",
  () => {
    // Incompressible content, so that the first part of the archive holds the start of the file and
    // the decompressor has given the file's first 64 KiB when the failure comes.
    const content = randomBytes(300_000);
    const bytes = gzipSync(tar([{ name: `${TOP}/big.bin`, content }]), { level: 0 });

    it("closes the file when the source fails", async () => {
      const thrown = new Error("the download failed");
      const settings = await options(
        fakeDriver(() => exited()),
        async (sink) => {
          await sink(bytes.subarray(0, 200_000));
          throw thrown;
        },
      );
      expect(await failure(analyseArchive(settings))).toBe(thrown);
      expect(await openInside(settings.workspaceRoot)).toEqual([]);
      expect(await left(settings.workspaceRoot)).toEqual([]);
    });

    it("closes the file when the unpacking fails and the source goes on as if it had not", async () => {
      // The source is told by its sink that the unpacking failed, and a source that does not stop
      // for that is one that the unpacking is still finished and closed for.
      const settings = await options(
        fakeDriver(() => exited()),
        async (sink) => {
          try {
            await sink(bytes);
          } catch {
            // carries on
          }
        },
        { unpackLimits: { maxDecompressedBytes: 100_000 } },
      );
      expect(await code(analyseArchive(settings))).toBe("repository_too_large");
      expect(await openInside(settings.workspaceRoot)).toEqual([]);
      expect(await left(settings.workspaceRoot)).toEqual([]);
    });
  },
);

describe("analyseArchive, the copies of the repository", () => {
  it("removes the unpacked copy and the staged one however the analysis ends", async () => {
    const outcomes: (() => Promise<SandboxResult>)[] = [
      () => Promise.resolve(exited({ exitCode: 1 })),
      () => Promise.resolve(exited({ outcome: "timed_out", exitCode: null })),
      () => Promise.reject(new SandboxError("run_failed")),
      () => Promise.reject(new Error("anything")),
    ];
    for (const outcome of outcomes) {
      const settings = await options(fakeDriver(outcome), giving(archiveOf()));
      await expect(analyseArchive(settings)).rejects.toBeInstanceOf(AnalysisError);
      expect(await left(settings.workspaceRoot)).toEqual([]);
    }
    const settings = await options(standIn(), giving(archiveOf()));
    await analyseArchive(settings);
    expect(await left(settings.workspaceRoot)).toEqual([]);
  }, 60_000);

  it("holds the unpacked copy and the staged one, and nothing else, while the sandbox runs", async () => {
    let seen: string[] = [];
    const driver = fakeDriver(async (request) => {
      seen = await readdir(dirname(request.sourceDirectory ?? ""));
      return exited({ exitCode: 1 });
    });
    await failure(analyseArchive(await options(driver, giving(archiveOf()))));
    expect(seen.map((name) => name.replace(/-.*/, "")).sort()).toEqual(["analysis", "checkout"]);
  });

  it("keeps a path that looks like the working copies' own names inside the repository", async () => {
    const bytes = gzipSync(tar([{ name: `${TOP}/checkout-x/analysis-y/a.ts`, content: "x" }]));
    const settings = await options(standIn(), giving(bytes));
    const facts = await analyseArchive(settings);
    expect(facts.files.map((file) => file.path)).toEqual(["checkout-x/analysis-y/a.ts"]);
    expect(await left(settings.workspaceRoot)).toEqual([]);
  }, 60_000);
});
