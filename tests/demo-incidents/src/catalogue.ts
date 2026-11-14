import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { incidentSchema, type Incident } from "./schema.js";

export const INCIDENTS_DIRECTORY = fileURLToPath(new URL("../incidents/", import.meta.url));

/**
 * Reads the incidents in `directory`, each one checked against the schema. A file that does not
 * match says where, and nothing of its contents. A file is named for its incident.
 */
export async function loadIncidents(directory: string = INCIDENTS_DIRECTORY): Promise<Incident[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const incidents: Incident[] = [];
  for (const name of names) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(directory, name), "utf8"));
    } catch {
      throw new Error(`${name} is not JSON`);
    }
    const result = incidentSchema.safeParse(parsed);
    if (!result.success) {
      const where = result.error.issues
        .map((issue) => issue.path.join(".") || "(the whole file)")
        .join(", ");
      throw new Error(`${name} does not match the schema at: ${where}`);
    }
    if (`${result.data.id}.json` !== basename(name)) {
      throw new Error(
        `${name} holds the incident ${result.data.id}, which names the file differently`,
      );
    }
    incidents.push(result.data);
  }
  return incidents;
}
