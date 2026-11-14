import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Edit } from "./schema.js";

/** An edit that could not be made. It names the file and the edit, and never the text. */
export class EditError extends Error {
  readonly code: "not_found" | "ambiguous" | "unchanged" | "empty";
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
    // Text of nothing is found everywhere, and searching for it would never end.
    if (find === "" || replace === "") throw new EditError("empty", edit.file, index);
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

/**
 * One hash for every file under `directory`, by path and content, so that two trees can be compared.
 *
 * Each file is hashed by itself, and the hash of the tree is the hash of one line for each file, in
 * the order of the paths: the path as JSON (which has no line feed in it) and the file's own hash,
 * which is always 64 characters. The lines cannot be run together into a different tree, whatever a
 * file holds, which they could if the contents themselves were put in the hash with a separator.
 */
export async function treeHash(directory: string): Promise<string> {
  const names = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .sort();
  const tree = createHash("sha256");
  for (const name of names) {
    const file = createHash("sha256")
      .update(await readFile(join(directory, name)))
      .digest("hex");
    tree.update(`${JSON.stringify(name)} ${file}\n`);
  }
  return tree.digest("hex");
}
