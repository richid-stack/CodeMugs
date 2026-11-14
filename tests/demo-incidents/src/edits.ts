import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Edit } from "./schema.js";

/** An edit that could not be made. It names the file and the edit, and never the text. */
export class EditError extends Error {
  readonly code: "not_found" | "ambiguous" | "unchanged";
  readonly file: string;
  readonly index: number;

  constructor(code: EditError["code"], file: string, index: number) {
    super(`edit ${index + 1} in ${file}: ${code}`);
    this.name = "EditError";
    this.code = code;
    this.file = file;
    this.index = index;
  }
}

function occurrences(text: string, find: string): number {
  let count = 0;
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + find.length))
    count += 1;
  return count;
}

/** Makes the edits to the files of `directory`, one after the other. Each must find its text once. */
export async function applyEdits(directory: string, edits: readonly Edit[]): Promise<void> {
  for (const [index, edit] of edits.entries()) {
    const path = join(directory, edit.file);
    const before = await readFile(path, "utf8");
    const find = edit.find.join("\n");
    const replace = edit.replace.join("\n");
    if (find === replace) throw new EditError("unchanged", edit.file, index);
    const found = occurrences(before, find);
    if (found === 0) throw new EditError("not_found", edit.file, index);
    if (found > 1) throw new EditError("ambiguous", edit.file, index);
    await writeFile(
      path,
      before.replace(find, () => replace),
    );
  }
}

/** The edits that undo these, in the order that undoes them: the reference fix. */
export function invertEdits(edits: readonly Edit[]): Edit[] {
  return edits
    .map((edit) => ({ file: edit.file, find: edit.replace, replace: edit.find }))
    .reverse();
}

/** One hash for every file under `directory`, by path and content, so that two trees can be compared. */
export async function treeHash(directory: string): Promise<string> {
  const names = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1))
    .sort();
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(join(directory, name)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
