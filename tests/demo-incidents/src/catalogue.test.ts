import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INCIDENTS_DIRECTORY, loadIncidents } from "./catalogue.js";
import { DETECTOR_NAMES } from "./detectors.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "catalogue-test-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function realFile(): Promise<{ name: string; json: Record<string, unknown> }> {
  const name = (await readdir(INCIDENTS_DIRECTORY))
    .filter((file) => file.endsWith(".json"))
    .sort()[0];
  if (name === undefined) throw new Error("no incidents");
  const json = JSON.parse(await readFile(join(INCIDENTS_DIRECTORY, name), "utf8")) as Record<
    string,
    unknown
  >;
  return { name, json };
}

describe("loadIncidents", () => {
  it("reads the incidents of this package, in the order of their names", async () => {
    const incidents = await loadIncidents();
    const names = (await readdir(INCIDENTS_DIRECTORY))
      .filter((file) => file.endsWith(".json"))
      .sort();
    expect(incidents.map((incident) => `${incident.id}.json`)).toEqual(names);
    expect(incidents.length).toBeGreaterThanOrEqual(5);
  });

  it("gives each incident one id, and has one incident for every detector", async () => {
    const incidents = await loadIncidents();
    expect(new Set(incidents.map((incident) => incident.id)).size).toBe(incidents.length);
    expect(new Set(incidents.map((incident) => incident.symptoms.detector))).toEqual(
      new Set(DETECTOR_NAMES),
    );
  });

  it("reads an empty directory as no incidents, and ignores files that are not JSON", async () => {
    expect(await loadIncidents(directory)).toEqual([]);
    await writeFile(join(directory, "notes.txt"), "not an incident");
    expect(await loadIncidents(directory)).toEqual([]);
  });

  it("reads incidents in the order of their names, whatever order they were made in", async () => {
    const { name, json } = await realFile();
    const ids = [
      "zeta-fault",
      "alpha-fault",
      "mu-fault",
      "beta-fault",
      "omega-fault",
      "gamma-fault",
    ];
    for (const id of ids) {
      await writeFile(join(directory, `${id}.json`), JSON.stringify({ ...json, id }));
    }
    expect(name.endsWith(".json")).toBe(true);
    expect((await loadIncidents(directory)).map((incident) => incident.id)).toEqual(
      [...ids].sort(),
    );
  });

  it("reads a copy of a real incident", async () => {
    const { name } = await realFile();
    await cp(join(INCIDENTS_DIRECTORY, name), join(directory, name));
    expect(await loadIncidents(directory)).toHaveLength(1);
  });

  it("refuses a file that is not named for its incident, and says which", async () => {
    const { json } = await realFile();
    await writeFile(join(directory, "another-name.json"), JSON.stringify(json));
    await expect(loadIncidents(directory)).rejects.toThrow(
      `another-name.json holds the incident ${String(json["id"])}, which names the file differently`,
    );
  });

  it("refuses a file that is not JSON, and names it", async () => {
    await writeFile(join(directory, "broken.json"), "{ not json");
    await expect(loadIncidents(directory)).rejects.toThrow("broken.json is not JSON");
  });

  it("says where a file does not match the schema, and nothing of what it holds", async () => {
    const { name, json } = await realFile();
    await writeFile(
      join(directory, name),
      JSON.stringify({ ...json, difficulty: "a-secret-value", surprise: true }),
    );
    const failure = await loadIncidents(directory).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(`${name} does not match the schema at:`);
    expect(message).toContain("difficulty");
    expect(message).not.toContain("a-secret-value");
  });

  it("fails when the directory is not there", async () => {
    await mkdir(join(directory, "a"));
    await expect(loadIncidents(join(directory, "none"))).rejects.toThrow();
  });
});
