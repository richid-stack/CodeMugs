import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateShop, HarnessError, runShopTests, runShopTraffic } from "./evaluate.js";
import { materialiseShop } from "./materialise.js";

vi.setConfig({ testTimeout: 120_000 });

const run = promisify(execFile);

let root: string;
let copy: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "evaluate-test-"));
  copy = join(root, "copy");
  await materialiseShop(copy);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("running a copy of the shop", () => {
  it("says how each test went, with the file and the name", async () => {
    const tests = await runShopTests(copy);
    expect(tests.length).toBeGreaterThan(50);
    expect(tests.every((test) => test.status === "passed")).toBe(true);
    expect(tests).toContainEqual({
      file: "money.test.ts",
      name: expect.any(String) as string,
      status: "passed",
    });
  });

  it("says that a test failed, and keeps the ones that passed", async () => {
    await writeFile(
      join(copy, "src", "extra.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { it } from "node:test";',
        'it("fails on purpose", () => assert.equal(1, 2));',
        'it("passes", () => assert.equal(1, 1));',
        'it.skip("is skipped", () => undefined);',
        "",
      ].join("\n"),
    );
    const extra = (await runShopTests(copy)).filter((test) => test.file === "extra.test.ts");
    expect(extra).toEqual([
      { file: "extra.test.ts", name: "fails on purpose", status: "failed" },
      { file: "extra.test.ts", name: "is skipped", status: "skipped" },
      { file: "extra.test.ts", name: "passes", status: "passed" },
    ]);
  });

  it("runs with no environment, so that the copy sees nothing of this machine", async () => {
    process.env["DEMO_HARNESS_PROBE"] = "visible";
    try {
      await writeFile(
        join(copy, "src", "env.test.ts"),
        [
          'import assert from "node:assert/strict";',
          'import { it } from "node:test";',
          'it("sees no variables of the caller", () => {',
          '  for (const name of ["DEMO_HARNESS_PROBE", "PATH", "HOME"]) {',
          "    assert.equal(process.env[name], undefined, name);",
          "  }",
          "});",
          "",
        ].join("\n"),
      );
      const tests = await runShopTests(copy);
      expect(tests.find((test) => test.file === "env.test.ts")?.status).toBe("passed");
    } finally {
      delete process.env["DEMO_HARNESS_PROBE"];
    }
  });

  it("lists as failing only the tests that failed, with the file", async () => {
    await writeFile(
      join(copy, "src", "extra.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import { it } from "node:test";',
        'it("fails on purpose", () => assert.equal(1, 2));',
        'it.skip("is skipped", () => undefined);',
        'it("passes", () => assert.equal(1, 1));',
        "",
      ].join("\n"),
    );
    const evaluation = await evaluateShop(copy, 1);
    expect(evaluation.failing).toEqual(["extra.test.ts > fails on purpose"]);
    expect(evaluation.findings).toEqual([]);
    expect(evaluation.statuses["201"]).toBeGreaterThan(50);
  });

  it("gives traffic for a seed, and the same traffic for the same seed", async () => {
    const first = await runShopTraffic(copy, 7);
    const second = await runShopTraffic(copy, 7);
    expect(first.statuses).toEqual(second.statuses);
    expect(first.events.map((event) => event.type).sort()).toEqual(
      second.events.map((event) => event.type).sort(),
    );
    expect(first.statuses["201"]).toBeGreaterThan(50);
  });

  it("does not stop at a copy that crashes: it says so, with the exit code and the last of what it said", async () => {
    await writeFile(join(copy, "src", "shop.ts"), 'throw new Error("boom from the copy");\n');
    const failure = await runShopTraffic(copy, 1).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HarnessError);
    const error = failure as HarnessError;
    expect(error.script).toBe("run-traffic.ts");
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("run-traffic.ts exited with 1");
    expect(error.message).toContain("boom from the copy");
  });

  it("stops a copy that takes too long", async () => {
    const failure = await runShopTests(copy, 1).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HarnessError);
    const error = failure as HarnessError;
    expect(error.exitCode).toBeNull();
    expect(error.message).toBe("run-tests.ts did not finish: timed out");
  });

  it("says when what a copy printed is not JSON", async () => {
    await writeFile(
      join(copy, "src", "shop.ts"),
      'process.stdout.write("not json\\n");\nprocess.exit(0);\n',
    );
    const failure = await runShopTraffic(copy, 1).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HarnessError);
    expect((failure as HarnessError).message).toBe(
      "run-traffic.ts exited with 0: its last line of output is not JSON",
    );
  });

  it("says when there is no shop at the directory", async () => {
    const none = join(root, "none");
    await mkdir(none);
    const failure = await runShopTests(none).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HarnessError);
    expect((failure as HarnessError).exitCode).toBe(1);
  });

  it.each(["run-tests.ts", "run-traffic.ts"])(
    "%s refuses a directory that is not an absolute path, which it would read against its own",
    async (script) => {
      const path = fileURLToPath(new URL(`../traffic/${script}`, import.meta.url));
      for (const directory of ["", ".", "copy"]) {
        const failure = await run(process.execPath, [path, directory], { env: {} }).catch(
          (error: unknown) => error,
        );
        expect((failure as { code?: number }).code, `"${directory}"`).toBe(1);
        expect((failure as { stderr?: string }).stderr).toContain("absolute path");
      }
    },
  );
});
