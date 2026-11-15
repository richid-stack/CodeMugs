import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRepositoryFacts } from "./facts.js";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(...args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [main, ...args],
      { maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

let directory: string;

beforeAll(async () => {
  // The command is the built one, because that is what the sandbox runs: `pnpm build` comes first.
  expect(existsSync(main), "build the package first: pnpm build").toBe(true);
  directory = await mkdtemp(join(tmpdir(), "codemugs-cli-"));
  await writeFile(join(directory, "a.ts"), 'import x from "zod";\nprocess.env.SOME_NAME;\n');
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("the command that runs in the sandbox", { timeout: 60_000 }, () => {
  it("prints the facts as one line of JSON, and nothing else, and exits with 0", async () => {
    const result = await run(directory);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.trimEnd()).not.toContain("\n");
    const facts = parseRepositoryFacts(result.stdout);
    expect(facts.files.map((file) => file.path)).toEqual(["a.ts"]);
    expect(facts.envVars.map((entry) => entry.name)).toEqual(["SOME_NAME"]);
  });

  it("exits with 2 and prints nothing when it is not given an absolute path", async () => {
    const cases = [[], ["relative/path"], ["."], [""]];
    const results = await Promise.all(cases.map((args) => run(...args)));
    for (const [index, result] of results.entries()) {
      expect(result, JSON.stringify(cases[index])).toEqual({ code: 2, stdout: "", stderr: "" });
    }
  });

  it("exits with 1 and prints nothing when the repository cannot be read", async () => {
    const missing = await run(join(directory, "does-not-exist"));
    expect(missing).toEqual({ code: 1, stdout: "", stderr: "" });
    const file = await run(join(directory, "a.ts"));
    expect(file).toEqual({ code: 1, stdout: "", stderr: "" });
  });

  it("does not print the path that it was given, or anything of the repository, on a failure", async () => {
    const result = await run(join(directory, "SECRET-DIRECTORY-NAME"));
    expect(result.stdout + result.stderr).not.toContain("SECRET");
  });
});
