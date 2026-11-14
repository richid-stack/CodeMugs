// Runs the tests of a copy of the shop with Node's own test runner, and says how each one went.
// It is run by plain Node, in a process of its own, and imports nothing from this repository.
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { run } from "node:test";

const root = process.argv[2];
if (root === undefined || !isAbsolute(root)) {
  throw new Error("usage: run-tests.ts <absolute path of the directory of the shop>");
}

const source = join(root, "src");
const files = (await readdir(source, { recursive: true }))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => join(source, name));

const tests: { file: string; name: string; status: "passed" | "failed" | "skipped" }[] = [];
const stream = run({ files, concurrency: false, cwd: root });
const file = (path: string | undefined): string =>
  path === undefined ? "?" : relative(source, path);
stream.on("test:pass", (event) => {
  if (event.details.type === "test") {
    tests.push({
      file: file(event.file),
      name: event.name,
      status: event.skip ? "skipped" : "passed",
    });
  }
});
stream.on("test:fail", (event) => {
  if (event.details.type === "test")
    tests.push({ file: file(event.file), name: event.name, status: "failed" });
});
// The runner only goes on while something reads the stream.
for await (const ignored of stream) void ignored;

tests.sort((a, b) => `${a.file}\n${a.name}`.localeCompare(`${b.file}\n${b.name}`));
process.stdout.write(`${JSON.stringify({ files: files.length, tests })}\n`);
