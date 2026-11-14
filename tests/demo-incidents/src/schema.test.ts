import { describe, expect, it } from "vitest";
import { incidentSchema } from "./schema.js";

const valid = {
  id: "example-fault",
  title: "An example of an incident",
  kind: "boundary",
  severity: "medium",
  difficulty: 2,
  rootCause: "A line is off by one, which loses the last item of the last page.",
  edits: [{ file: "src/orders.ts", find: ["a"], replace: ["b"] }],
  symptoms: {
    detector: "pages-miss-orders",
    telemetry: "The pages hold fewer orders in all than the total.",
    report: { channel: "support", text: "My newest order is not in my list of orders." },
  },
  witness: { failingTests: ["orders.test.ts > lists the newest first"] },
};

function with_(change: (copy: Record<string, unknown>) => void): unknown {
  const copy = structuredClone(valid) as Record<string, unknown>;
  change(copy);
  return copy;
}

describe("incidentSchema", () => {
  it("accepts a complete incident", () => {
    expect(incidentSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ["the incident", (copy: Record<string, unknown>) => (copy["extra"] = 1)],
    [
      "an edit",
      (copy: Record<string, unknown>) =>
        Object.assign((copy["edits"] as Record<string, unknown>[])[0] ?? {}, { extra: 1 }),
    ],
    [
      "the symptoms",
      (copy: Record<string, unknown>) =>
        Object.assign(copy["symptoms"] as Record<string, unknown>, { extra: 1 }),
    ],
    [
      "the report",
      (copy: Record<string, unknown>) =>
        Object.assign((copy["symptoms"] as { report: Record<string, unknown> }).report, {
          extra: 1,
        }),
    ],
    [
      "the witness",
      (copy: Record<string, unknown>) =>
        Object.assign(copy["witness"] as Record<string, unknown>, { extra: 1 }),
    ],
  ])("refuses a key it does not know in %s", (_where, change) => {
    expect(incidentSchema.safeParse(with_(change)).success).toBe(false);
  });

  it.each(["Upper-case", "ab", "1starts-with-a-number", "has space", "has_underscore", ""])(
    "refuses the id %j",
    (id) => {
      expect(incidentSchema.safeParse(with_((copy) => (copy["id"] = id))).success).toBe(false);
    },
  );

  it.each([
    "../outside.ts",
    "src/../outside.ts",
    "src/./orders.ts",
    "src//orders.ts",
    "src/a//b.ts",
    "src/a/./b.ts",
    "src/a/../b.ts",
    "src/a/..",
    "/etc/passwd",
    "package.json",
    "src/orders.js",
    "src/orders.ts/",
    "tests/orders.ts",
    "src/Orders.ts",
    "",
  ])("refuses the path %j for an edit", (file) => {
    const change = (copy: Record<string, unknown>): void => {
      (copy["edits"] as { file: string }[])[0]!.file = file;
    };
    expect(incidentSchema.safeParse(with_(change)).success).toBe(false);
  });

  it("accepts a path in a directory of src", () => {
    const change = (copy: Record<string, unknown>): void => {
      (copy["edits"] as { file: string }[])[0]!.file = "src/lib/orders-2.ts";
    };
    expect(incidentSchema.safeParse(with_(change)).success).toBe(true);
  });

  it.each([0, 4, 1.5, -1, "2"])("refuses the difficulty %j", (difficulty) => {
    expect(
      incidentSchema.safeParse(with_((copy) => (copy["difficulty"] = difficulty))).success,
    ).toBe(false);
  });

  it.each([1, 2, 3])("accepts the difficulty %j", (difficulty) => {
    expect(
      incidentSchema.safeParse(with_((copy) => (copy["difficulty"] = difficulty))).success,
    ).toBe(true);
  });

  it("refuses a kind, a severity and a detector that it does not list", () => {
    expect(incidentSchema.safeParse(with_((copy) => (copy["kind"] = "typo"))).success).toBe(false);
    expect(incidentSchema.safeParse(with_((copy) => (copy["severity"] = "urgent"))).success).toBe(
      false,
    );
    const detector = (copy: Record<string, unknown>): void => {
      (copy["symptoms"] as { detector: string }).detector = "no-such-detector";
    };
    expect(incidentSchema.safeParse(with_(detector)).success).toBe(false);
  });

  it("refuses a channel that it does not list", () => {
    const change = (copy: Record<string, unknown>): void => {
      (copy["symptoms"] as { report: { channel: string } }).report.channel = "carrier-pigeon";
    };
    expect(incidentSchema.safeParse(with_(change)).success).toBe(false);
  });

  it("refuses no edits, an edit with no lines, and a line that holds a line feed", () => {
    expect(incidentSchema.safeParse(with_((copy) => (copy["edits"] = []))).success).toBe(false);
    const noFind = (copy: Record<string, unknown>): void => {
      (copy["edits"] as { find: string[] }[])[0]!.find = [];
    };
    expect(incidentSchema.safeParse(with_(noFind)).success).toBe(false);
    const noReplace = (copy: Record<string, unknown>): void => {
      (copy["edits"] as { replace: string[] }[])[0]!.replace = [];
    };
    expect(incidentSchema.safeParse(with_(noReplace)).success).toBe(false);
    const lineFeed = (copy: Record<string, unknown>): void => {
      (copy["edits"] as { find: string[] }[])[0]!.find = ["one\ntwo"];
    };
    expect(incidentSchema.safeParse(with_(lineFeed)).success).toBe(false);
  });

  it("refuses an empty witness, and a witness test with no name", () => {
    const none = (copy: Record<string, unknown>): void => {
      (copy["witness"] as { failingTests: string[] }).failingTests = [];
    };
    expect(incidentSchema.safeParse(with_(none)).success).toBe(false);
    const blank = (copy: Record<string, unknown>): void => {
      (copy["witness"] as { failingTests: string[] }).failingTests = [""];
    };
    expect(incidentSchema.safeParse(with_(blank)).success).toBe(false);
  });

  it("refuses a title and a root cause that are too short", () => {
    expect(incidentSchema.safeParse(with_((copy) => (copy["title"] = "Bug"))).success).toBe(false);
    expect(
      incidentSchema.safeParse(with_((copy) => (copy["rootCause"] = "Too short"))).success,
    ).toBe(false);
  });
});
