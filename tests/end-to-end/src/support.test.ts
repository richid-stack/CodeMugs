import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linesFoundIn, sourceLinesOf } from "./support.js";

// The check that no source text is in an answer is only as good as these two, so they are tested
// without a database.
describe("looking for source text", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "source-lines-"));
    await mkdir(join(root, "src", "deep"), { recursive: true });
    await writeFile(
      join(root, "src", "a.ts"),
      'export const greeting = "hello, world";\r\n  });\n\n  return total + shipping;\n',
    );
    await writeFile(
      join(root, "src", "deep", "b.ts"),
      "export const greeting = \"hello, world\";\nconst answer = compute(42, 'x');\n",
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists the distinct lines of every file below the directory, trimmed, and not the short ones", async () => {
    expect(await sourceLinesOf(root)).toEqual([
      "const answer = compute(42, 'x');",
      'export const greeting = "hello, world";',
      "return total + shipping;",
    ]);
    expect(await sourceLinesOf(root, 3)).toContain("});");
  });

  it("finds a line where it is written as it is", () => {
    expect(
      linesFoundIn("xx return total + shipping; yy", ["return total + shipping;", "nothing"]),
    ).toEqual(["return total + shipping;"]);
  });

  it("finds a line that has quotes in it when it is in JSON, where the quotes are escaped", () => {
    const line = 'export const greeting = "hello, world";';
    const answer = JSON.stringify({ attributes: { text: line } });
    expect(answer.includes(line)).toBe(false);
    expect(linesFoundIn(answer, [line])).toEqual([line]);
  });

  it("finds nothing in an answer that has only names", () => {
    expect(
      linesFoundIn('{"nodes":[{"kind":"file","key":"src/a.ts"}]}', [
        "return total + shipping;",
        'export const greeting = "hello, world";',
      ]),
    ).toEqual([]);
  });
});
