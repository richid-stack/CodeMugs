import type { TenantClient } from "@codemugs/storage";
import { describe, expect, it } from "vitest";
import {
  findNode,
  getRun,
  GraphError,
  importClosure,
  latestRun,
  listNodes,
  MAX_DEPTH,
  MAX_LIMIT,
  neighbours,
} from "./index.js";

const ORGANISATION = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

/** A client that records what it was asked and finds nothing. */
function recorder() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    organisationId: ORGANISATION,
    query: (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as TenantClient;
  return { client, calls };
}

async function refused(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof GraphError) return error.code;
    throw error;
  }
  throw new Error("expected a GraphError");
}

describe("what a read refuses before it asks the database", () => {
  const cases: Array<[string, (client: TenantClient) => Promise<unknown>]> = [
    ["a run id that is not a UUID", (c) => getRun(c, "1; DROP TABLE analysis_runs")],
    ["a project id that is not a UUID", (c) => latestRun(c, "not-a-uuid")],
    ["a run id that is not a UUID, when finding a node", (c) => findNode(c, "x", "file", "a")],
    ["a run id that is not a UUID, when listing nodes", (c) => listNodes(c, "x")],
    [
      "a run id that is not a UUID, when following edges",
      (c) => neighbours(c, "x", 1, { direction: "out" }),
    ],
    [
      "a run id that is not a UUID, when walking imports",
      (c) => importClosure(c, "x", "a.ts", { direction: "imports" }),
    ],
    ["a limit of zero", (c) => listNodes(c, RUN, { limit: 0 })],
    ["a limit above the largest", (c) => listNodes(c, RUN, { limit: MAX_LIMIT + 1 })],
    ["a limit that is not whole", (c) => listNodes(c, RUN, { limit: 1.5 })],
    ["a limit that is not a number", (c) => listNodes(c, RUN, { limit: Number.NaN })],
    ["an afterId that is not whole", (c) => listNodes(c, RUN, { afterId: 0.5 })],
    ["a node number below zero", (c) => neighbours(c, RUN, -1, { direction: "out" })],
    ["a node number that is not whole", (c) => neighbours(c, RUN, 1.5, { direction: "out" })],
    [
      "a direction that is neither",
      (c) => neighbours(c, RUN, 1, { direction: "sideways" as unknown as "out" }),
    ],
    [
      "a limit of zero, for neighbours",
      (c) => neighbours(c, RUN, 1, { direction: "in", limit: 0 }),
    ],
    [
      "a depth above the largest",
      (c) => importClosure(c, RUN, "a.ts", { direction: "imports", maxDepth: MAX_DEPTH + 1 }),
    ],
    [
      "a depth of zero",
      (c) => importClosure(c, RUN, "a.ts", { direction: "imports", maxDepth: 0 }),
    ],
    [
      "a limit of zero, for a closure",
      (c) => importClosure(c, RUN, "a.ts", { direction: "importers", limit: 0 }),
    ],
    [
      "a direction that is neither, for a closure",
      (c) => importClosure(c, RUN, "a.ts", { direction: "both" as unknown as "imports" }),
    ],
  ];

  it.each(cases)("refuses %s, and asks nothing", async (_name, call) => {
    const { client, calls } = recorder();
    expect(await refused(call(client))).toBe("invalid_input");
    expect(calls).toEqual([]);
  });
});

describe("what a read asks the database", () => {
  it("has the bounds that the README gives", () => {
    expect(MAX_LIMIT).toBe(10_000);
    expect(MAX_DEPTH).toBe(50);
  });

  it("always names the organisation of the client first, and passes the caller's values apart", async () => {
    const { client, calls } = recorder();
    await getRun(client, RUN);
    await latestRun(client, PROJECT);
    await findNode(client, RUN, "file", "src/a.ts");
    await listNodes(client, RUN, { kind: "file" });
    await neighbours(client, RUN, 3, { direction: "in", kind: "imports" });
    await importClosure(client, RUN, "src/a.ts", { direction: "importers" });

    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const call of calls) {
      expect(call.values[0]).toBe(ORGANISATION);
      expect(call.text).toMatch(/organisation_id = \$1/);
    }
    // What a caller chose is a parameter, never part of the text of a query.
    const asked = calls.map((call) => call.text).join("\n");
    expect(asked).not.toContain("src/a.ts");
  });

  it("gives at most 1,000 when no limit is said, and the largest limit is allowed", async () => {
    const { client, calls } = recorder();
    await listNodes(client, RUN);
    await listNodes(client, RUN, { limit: MAX_LIMIT });
    expect(calls[0]?.values.at(-1)).toBe(1_000);
    expect(calls[1]?.values.at(-1)).toBe(MAX_LIMIT);
  });

  it("finds nothing in a run with no files to start from, without walking", async () => {
    const { client, calls } = recorder();
    expect(await importClosure(client, RUN, "src/missing.ts", { direction: "imports" })).toEqual(
      [],
    );
    expect(calls).toHaveLength(1);
  });
});
