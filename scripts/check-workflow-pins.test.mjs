import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { checkDirectory, findUnpinned } from "./check-workflow-pins.mjs";

const SHA = "11d5960a326750d5838078e36cf38b85af677262";
const DIGEST = `sha256:${"a".repeat(64)}`;
const script = fileURLToPath(new URL("./check-workflow-pins.mjs", import.meta.url));

const uses = (ref, prefix = "      - ") => `${prefix}uses: ${ref}\n`;
const problems = (text) => findUnpinned(text).map(({ line, problem }) => ({ line, problem }));

describe("an action that is pinned", () => {
  for (const ref of [
    `actions/checkout@${SHA}`,
    `actions/checkout@${SHA} # v4.4.0`,
    `"actions/checkout@${SHA}"`,
    `"actions/checkout@${SHA}" # v4.4.0`,
    `'actions/checkout@${SHA}'`,
    `'actions/checkout@${SHA}' # v4.4.0`,
    `owner/repo/path/to/action@${SHA}`,
    `owner/repo/.github/workflows/reusable.yml@${SHA}`,
    "./.github/actions/local",
    `docker://alpine@${DIGEST}`,
    `docker://ghcr.io/owner/image:1.2@${DIGEST}`,
  ]) {
    it(`is accepted: ${ref}`, () => {
      assert.deepEqual(findUnpinned(uses(ref)), []);
    });
  }

  it("is accepted without the list dash", () => {
    assert.deepEqual(findUnpinned(`        uses: actions/checkout@${SHA}\n`), []);
  });
});

describe("a reference that can move or is incomplete", () => {
  for (const ref of [
    "actions/checkout@v4",
    "actions/checkout@v4.4.0",
    "actions/checkout@main",
    "actions/checkout@latest",
    `actions/checkout@${SHA.slice(0, 7)}`,
    `actions/checkout@${SHA.slice(0, 39)}`,
    `actions/checkout@${SHA}0`,
    `actions/checkout@${SHA.toUpperCase()}`,
    `actions/checkout@${"g".repeat(40)}`,
    "actions/checkout@",
    "actions/checkout",
    `"actions/checkout@v4"`,
    `'actions/checkout@v4'`,
    "owner/repo/.github/workflows/reusable.yml@main",
  ]) {
    it(`is refused: ${ref}`, () => {
      const found = findUnpinned(uses(ref));
      assert.equal(found.length, 1);
      assert.equal(found[0].line, 1);
    });
  }

  it("is refused when a SHA is only in the version comment", () => {
    assert.equal(findUnpinned(uses(`actions/checkout@v4 # ${SHA}`)).length, 1);
  });

  it("is refused when the pin is on another action's name", () => {
    assert.equal(findUnpinned(uses(`actions/checkout@v4/${SHA}`)).length, 1);
  });
});

describe("a container image", () => {
  for (const ref of [
    "docker://alpine:3",
    "docker://alpine",
    "docker://alpine@sha256:abc",
    "docker://alpine@latest",
    `docker://alpine@${DIGEST}0`,
    `docker://alpine@x${DIGEST}`,
    `docker://alpine@${DIGEST.toUpperCase()}`,
  ]) {
    it(`is refused when it is not pinned by a full digest: ${ref}`, () => {
      assert.equal(findUnpinned(uses(ref)).length, 1);
    });
  }
});

describe("a reference written in a form this check does not read", () => {
  for (const [name, text] of [
    ["inside braces", `      - { uses: actions/checkout@${SHA} }\n`],
    ["inside braces after another key", "      - { name: checkout, uses: actions/checkout@v4 }\n"],
    ["with the value on the next line", `      - uses:\n          actions/checkout@${SHA}\n`],
    ["with an empty value", "      - uses:\n"],
    ["with a block value", `      - uses: |\n          actions/checkout@${SHA}\n`],
    ["with an anchor", `      - uses: &checkout actions/checkout@${SHA}\n`],
    ["with an alias", "      - uses: *checkout\n"],
    ["with a quote that is not closed", `      - uses: "actions/checkout@${SHA}\n`],
  ]) {
    it(`is refused, not skipped: ${name}`, () => {
      assert.ok(findUnpinned(text).length >= 1);
    });
  }

  for (const [name, text, expected] of [
    ["a quoted key", `      - "uses": actions/checkout@v4\n`, 1],
    ["a single-quoted key", `      - 'uses': actions/checkout@v4\n`, 1],
    ["no space after the colon in a quoted key", `      - "uses":actions/checkout@v4\n`, 1],
    ["a pin that runs into a comment", `      - uses: actions/checkout@${SHA}#v4\n`, 1],
  ]) {
    it(`is still read: ${name}`, () => {
      assert.equal(findUnpinned(text).length, expected);
    });
  }

  for (const first of ['"', "'", "&", "*", "!", "|", ">", "%", "@", "`", "[", "]", "{", "}", ","]) {
    it(`is refused when the value starts with ${first}, which is not a plain value`, () => {
      assert.ok(findUnpinned(`      - uses: ${first}actions/checkout@${SHA}\n`).length >= 1);
    });
  }

  it("accepts a quoted key with a pinned value", () => {
    assert.deepEqual(findUnpinned(`      - "uses": actions/checkout@${SHA}\n`), []);
  });

  it("does not refuse braces on a comment line", () => {
    assert.deepEqual(findUnpinned("      # - { uses: actions/checkout@v4 }\n"), []);
  });
});

describe("what is not a reference", () => {
  it("is not looked at: comments, other keys and text that only mentions uses", () => {
    const text = [
      "# uses: actions/checkout@v4",
      "name: uses: actions/checkout@v4",
      "      - run: echo uses actions/checkout@v4",
      "      - name: reuses: x@v1",
      "",
    ].join("\n");
    assert.deepEqual(findUnpinned(text), []);
  });
});

describe("a file with several references", () => {
  it("says which lines are the problem", () => {
    const text = [
      "jobs:",
      "  a:",
      "    steps:",
      uses(`actions/checkout@${SHA}`).trimEnd(),
      uses("actions/setup-node@v4").trimEnd(),
      uses(`pnpm/action-setup@${SHA}`).trimEnd(),
      uses("gitleaks/gitleaks-action@v2").trimEnd(),
    ].join("\n");
    assert.deepEqual(
      problems(text).map(({ line }) => line),
      [5, 7],
    );
  });

  it("works with Windows line endings, and counts the same lines", () => {
    const text = [
      "jobs:",
      uses(`actions/checkout@${SHA}`).trimEnd(),
      uses("actions/checkout@v4").trimEnd(),
      "",
    ].join("\r\n");
    assert.deepEqual(
      findUnpinned(text).map(({ line }) => line),
      [3],
    );
  });

  it("works with old Mac line endings and with a separator that is not a line break in YAML 1.2", () => {
    assert.equal(findUnpinned(`jobs:\r${uses("actions/checkout@v4").trimEnd()}\r`).length, 1);
    assert.equal(findUnpinned(`${uses("actions/checkout@v4").trimEnd()}\u2028\n`).length, 1);
  });
});

describe("a directory of workflows", () => {
  /** @param {(directory: string) => Promise<void>} body */
  async function inTemp(body) {
    const directory = await mkdtemp(join(tmpdir(), "pins-"));
    try {
      await body(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const run = (directory) => spawnSync(process.execPath, [script, directory], { encoding: "utf8" });

  it("fails when it holds no workflow, so that a wrong path is not a pass", async () => {
    await inTemp(async (directory) => {
      await writeFile(join(directory, "notes.txt"), "uses: actions/checkout@v4\n");
      await assert.rejects(checkDirectory(directory), /nothing was checked/);
      const result = run(directory);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /nothing was checked/);
    });
  });

  it("fails when the directory does not exist", async () => {
    await inTemp(async (directory) => {
      assert.equal(run(join(directory, "missing")).status, 1);
    });
  });

  it("names the file and the line of each problem, and fails", async () => {
    await inTemp(async (directory) => {
      await writeFile(join(directory, "good.yml"), uses(`actions/checkout@${SHA}`));
      await writeFile(join(directory, "bad.yaml"), `jobs:\n${uses("actions/checkout@v4")}`);
      const result = run(directory);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /bad\.yaml:2: actions\/checkout@v4/);
      assert.doesNotMatch(result.stderr, /good\.yml/);
      assert.equal(result.stdout, "");
    });
  });

  it("passes when everything is pinned", async () => {
    await inTemp(async (directory) => {
      await mkdir(join(directory, "nested"));
      await writeFile(join(directory, "ci.yml"), uses(`actions/checkout@${SHA}`));
      const result = run(directory);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /is pinned/);
    });
  });

  it("checks .github/workflows of the current directory when it is given none", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", cwd: root });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /every action and image in \.github\/workflows is pinned/);
  });

  it("is true of this repository's own workflows", async () => {
    const found = await checkDirectory(
      fileURLToPath(new URL("../.github/workflows", import.meta.url)),
    );
    assert.deepEqual(found, []);
  });
});
