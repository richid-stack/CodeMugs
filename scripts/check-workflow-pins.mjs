// Fails if a workflow uses an action, a reusable workflow or a container image that is not pinned
// to something that cannot change: an action to a full commit SHA, an image to a digest.
// A tag or a branch can be moved to other code after it was reviewed. In March 2026 the tags of
// the Trivy GitHub Actions were moved to code that stole CI credentials (ADR 0019).
//
//   node scripts/check-workflow-pins.mjs [workflows directory]
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
// A line that is the `uses` key of a step or a job. What follows the colon is the value.
const KEY = /^\s*(?:-\s+)?["']?uses["']?\s*:([\s\S]*)$/;
// The key inside braces, which this check does not read: such a line is refused, not skipped.
const FLOW = /[{,]\s*["']?uses["']?\s*:/;
const QUOTED = /^(?:"([^"]*)"|'([^']*)')(?:\s+#[\s\S]*)?$/;
// A plain value cannot start with a character that YAML uses for quotes, anchors, aliases, tags,
// block text or flow collections. Such a value is refused, not guessed at.
const PLAIN = /^([^\s"'&*!|>%@`#[\]{},][^\s]*)(?:\s+#[\s\S]*)?$/;

/** @param {string} rest what follows `uses:` on its line */
function valueOf(rest) {
  const text = rest.trim();
  const quoted = QUOTED.exec(text);
  if (quoted !== null) return quoted[1] ?? quoted[2] ?? "";
  const plain = PLAIN.exec(text);
  return plain === null ? null : (plain[1] ?? null);
}

/**
 * @param {string} text the contents of one workflow file
 * @returns {{ line: number, uses: string, problem: string }[]}
 */
export function findUnpinned(text) {
  /** @type {{ line: number, uses: string, problem: string }[]} */
  const found = [];
  text.split(/\r\n|\r|\n/).forEach((raw, index) => {
    const line = index + 1;
    const key = KEY.exec(raw);
    if (key === null) {
      if (!raw.trimStart().startsWith("#") && FLOW.test(raw)) {
        found.push({
          line,
          uses: raw.trim(),
          problem: "written inside braces, which this check cannot read",
        });
      }
      return;
    }
    const uses = valueOf(key[1] ?? "");
    if (uses === null) {
      found.push({
        line,
        uses: raw.trim(),
        problem: "the value is not one string on this line, so it cannot be checked",
      });
      return;
    }
    if (uses.startsWith("./")) return; // a file of this repository
    if (uses.startsWith("docker://")) {
      const digest = uses.includes("@") ? uses.slice(uses.lastIndexOf("@") + 1) : "";
      if (!DIGEST.test(digest)) {
        found.push({ line, uses, problem: "a container image that is not pinned by digest" });
      }
      return;
    }
    const at = uses.lastIndexOf("@");
    if (at === -1) {
      found.push({ line, uses, problem: "no version at all" });
    } else if (!COMMIT.test(uses.slice(at + 1))) {
      found.push({
        line,
        uses,
        problem: "not pinned to a full commit SHA (a tag or branch can move)",
      });
    }
  });
  return found;
}

/**
 * @param {string} directory
 * @returns {Promise<{ file: string, line: number, uses: string, problem: string }[]>}
 */
export async function checkDirectory(directory) {
  const files = (await readdir(directory)).filter((name) => /\.ya?ml$/.test(name)).sort();
  if (files.length === 0) throw new Error("no workflow files were found, so nothing was checked");
  const all = [];
  for (const file of files) {
    for (const problem of findUnpinned(await readFile(join(directory, file), "utf8"))) {
      all.push({ file, ...problem });
    }
  }
  return all;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2] ?? ".github/workflows";
  try {
    const problems = await checkDirectory(directory);
    for (const { file, line, uses, problem } of problems) {
      console.error(`${file}:${line}: ${uses}: ${problem}`);
    }
    if (problems.length > 0) {
      console.error(
        `${problems.length} unpinned reference(s). Pin each to a full commit SHA or an image digest.`,
      );
      process.exit(1);
    }
    console.log(`every action and image in ${directory} is pinned`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "the check could not run");
    process.exit(1);
  }
}
