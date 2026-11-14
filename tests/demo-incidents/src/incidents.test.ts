// The proof that each incident is what it says it is. Each one is put into a copy of the shop, and
// the copy is run: its own tests, and a day of traffic whose telemetry the detectors read. Nothing
// here is taken on trust from the incident file, which is a claim, and this is what checks it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadIncidents } from "./catalogue.js";
import { DETECTOR_NAMES, detectAll } from "./detectors.js";
import { applyEdits, invertEdits, treeHash } from "./edits.js";
import { evaluateShop, runShopTraffic, type Evaluation } from "./evaluate.js";
import { materialiseIncident, materialiseShop } from "./materialise.js";

// Each evaluation starts a few Node processes, and CI runs several of these at once.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const SEEDS = [1, 2, 3] as const;
const incidents = await loadIncidents();

let root: string;
let baselineDirectory: string;
let baselineTree: string;
let baseline: Evaluation;
const baselineByOtherSeeds = new Map<number, ReturnType<typeof detectAll>>();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "demo-incidents-"));
  baselineDirectory = join(root, "baseline");
  await materialiseShop(baselineDirectory);
  baselineTree = await treeHash(baselineDirectory);
  baseline = await evaluateShop(baselineDirectory, 1);
  for (const seed of SEEDS.filter((seed) => seed !== 1)) {
    const traffic = await runShopTraffic(baselineDirectory, seed);
    baselineByOtherSeeds.set(seed, detectAll(traffic.events));
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the shop on main, before any fault", () => {
  it("passes every one of its tests, and skips none", () => {
    expect(baseline.tests.length).toBeGreaterThan(50);
    expect(baseline.tests.filter((test) => test.status !== "passed")).toEqual([]);
  });

  it("names its tests so that a file and a name say which one it is", () => {
    const names = baseline.tests.map((test) => `${test.file} > ${test.name}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives no finding to any detector, for any seed", () => {
    expect(baseline.findings).toEqual([]);
    expect([...baselineByOtherSeeds.values()]).toEqual([[], []]);
  });

  it("answers its traffic with successes, and refuses what it has no stock for", () => {
    expect(baseline.statuses["500"]).toBeUndefined();
    expect(baseline.statuses["201"]).toBeGreaterThan(50);
    // The last teapot goes to one of six, and the other five are told it is gone.
    expect(baseline.statuses["409"]).toBe(5);
  });
});

describe("the catalogue", () => {
  it("has one incident for each detector, and each detector fires for no other", () => {
    expect(incidents.map((incident) => incident.symptoms.detector).sort()).toEqual(
      [...DETECTOR_NAMES].sort(),
    );
  });

  it("names tests that the shop has, in every witness", () => {
    const names = new Set(baseline.tests.map((test) => `${test.file} > ${test.name}`));
    for (const incident of incidents) {
      for (const name of incident.witness.failingTests) {
        // A fault can add a test only by changing a test file, and these edit source files.
        expect(names.has(name), `${incident.id}: ${name}`).toBe(true);
      }
    }
  });

  it("edits only files that are not tests", () => {
    for (const incident of incidents) {
      for (const edit of incident.edits) {
        expect(edit.file.endsWith(".test.ts"), `${incident.id}: ${edit.file}`).toBe(false);
      }
    }
  });
});

describe.each(incidents)("incident $id", (incident) => {
  let faulty: Evaluation;
  let again: Evaluation;
  const otherSeeds = new Map<number, ReturnType<typeof detectAll>>();
  let fixed: Evaluation;
  let fixedTree: string;

  beforeAll(async () => {
    const faultyDirectory = join(root, `${incident.id}-faulty`);
    await materialiseIncident(faultyDirectory, incident);
    const [first, second, ...rest] = await Promise.all([
      evaluateShop(faultyDirectory, 1),
      evaluateShop(faultyDirectory, 1),
      ...SEEDS.filter((seed) => seed !== 1).map((seed) => runShopTraffic(faultyDirectory, seed)),
    ]);
    faulty = first;
    again = second;
    for (const [index, seed] of SEEDS.filter((seed) => seed !== 1).entries()) {
      const traffic = rest[index] as Awaited<ReturnType<typeof runShopTraffic>>;
      otherSeeds.set(seed, detectAll(traffic.events));
    }

    // The reference fix is the edits undone, applied to a copy of the faulty shop.
    const fixedDirectory = join(root, `${incident.id}-fixed`);
    await materialiseIncident(fixedDirectory, incident);
    await applyEdits(fixedDirectory, invertEdits(incident.edits));
    fixedTree = await treeHash(fixedDirectory);
    fixed = await evaluateShop(fixedDirectory, 1);
  });

  it("is not the shop as it is on main", async () => {
    const faultyDirectory = join(root, `${incident.id}-faulty`);
    expect(await treeHash(faultyDirectory)).not.toBe(baselineTree);
  });

  it("fails the tests of its witness, and no others", () => {
    expect([...faulty.failing].sort()).toEqual([...incident.witness.failingTests].sort());
  });

  it("is found by its own detector in the traffic, and by no other", () => {
    expect(faulty.findings.length).toBeGreaterThan(0);
    expect([...new Set(faulty.findings.map((finding) => finding.detector))]).toEqual([
      incident.symptoms.detector,
    ]);
  });

  it("is found again by the same detector for the other seeds", () => {
    expect(otherSeeds.size).toBe(SEEDS.length - 1);
    for (const [seed, findings] of otherSeeds) {
      expect([...new Set(findings.map((finding) => finding.detector))], `seed ${seed}`).toEqual([
        incident.symptoms.detector,
      ]);
    }
  });

  it("shows the same tests and the same findings when it is run again", () => {
    expect(again.failing).toEqual(faulty.failing);
    expect(again.findings).toEqual(faulty.findings);
    expect(again.statuses).toEqual(faulty.statuses);
  });

  it("does not fail every test: it is one thing wrong, and not a shop that does not start", () => {
    const passing = faulty.tests.filter((test) => test.status === "passed").length;
    expect(passing).toBeGreaterThan(faulty.tests.length / 2);
  });

  it("is removed by undoing its edits, which gives back the shop as it was on main", () => {
    expect(fixedTree).toBe(baselineTree);
  });

  it("passes every test and gives no finding once it is removed", () => {
    expect(fixed.tests.filter((test) => test.status !== "passed")).toEqual([]);
    expect(fixed.findings).toEqual([]);
    expect(fixed.statuses).toEqual(baseline.statuses);
  });
});
