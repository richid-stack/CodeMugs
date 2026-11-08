import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MigrationError } from "./errors.js";
import { loadMigrations } from "./migrate.js";

const directories: string[] = [];

async function migrationsDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codemugs-migrations-"));
  directories.push(directory);
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents);
  }
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("loadMigrations", () => {
  it("loads the migrations shipped with the package, in order, starting at 0001", async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]?.version).toBe("0001");
    migrations.forEach((migration, index) => {
      expect(migration.version).toBe(String(index + 1).padStart(4, "0"));
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("gives the same checksum for the same file and a different one when it changes", async () => {
    const one = await migrationsDirectory({ "0001_a.sql": "select 1;" });
    const same = await migrationsDirectory({ "0001_a.sql": "select 1;" });
    const changed = await migrationsDirectory({ "0001_a.sql": "select 2;" });
    const [a, b, c] = await Promise.all([one, same, changed].map((d) => loadMigrations(d)));
    expect(a?.[0]?.checksum).toBe(b?.[0]?.checksum);
    expect(a?.[0]?.checksum).not.toBe(c?.[0]?.checksum);
  });

  it("returns an empty list for a directory with no migrations and ignores other files", async () => {
    const directory = await migrationsDirectory({ "README.md": "notes", "0001_first.sql": "" });
    expect(await loadMigrations(directory)).toHaveLength(1);
    const empty = await migrationsDirectory({ "README.md": "notes" });
    expect(await loadMigrations(empty)).toEqual([]);
  });

  it.each(["1_first.sql", "0001_First.sql", "0001-first.sql", "0001_.sql", "first.sql"])(
    "rejects the badly named file %s",
    async (name) => {
      const directory = await migrationsDirectory({ [name]: "select 1;" });
      await expect(loadMigrations(directory)).rejects.toBeInstanceOf(MigrationError);
    },
  );

  it("rejects a gap in the numbering", async () => {
    const directory = await migrationsDirectory({ "0001_a.sql": "", "0003_c.sql": "" });
    await expect(loadMigrations(directory)).rejects.toThrow(
      /expected migration 0002 but found 0003/,
    );
  });

  it("rejects two migrations with the same number", async () => {
    const directory = await migrationsDirectory({ "0001_a.sql": "", "0001_b.sql": "" });
    await expect(loadMigrations(directory)).rejects.toThrow(
      /expected migration 0002 but found 0001/,
    );
  });

  it("rejects numbering that does not start at 0001", async () => {
    const directory = await migrationsDirectory({ "0002_b.sql": "" });
    await expect(loadMigrations(directory)).rejects.toThrow(
      /expected migration 0001 but found 0002/,
    );
  });
});
