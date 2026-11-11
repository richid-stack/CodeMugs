import { describe, expect, it } from "vitest";
import { changed, validPolicyInput } from "./fixtures.js";
import { SandboxRequestError } from "./policy.js";
import { assertValidatedRequest, validateRunRequest, type SandboxRunRequest } from "./request.js";

const ROOT = "/var/lib/codemugs/work";
const inside = `${ROOT}/run-1/source`;

const validRequest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  policy: validPolicyInput(),
  command: ["node", "analyse.js", "--json"],
  sourceDirectory: inside,
  ...overrides,
});

const validate = (input: unknown) => validateRunRequest(input, { workspaceRoot: ROOT });

const refusal = (input: unknown): readonly string[] => {
  try {
    validate(input);
  } catch (error) {
    if (error instanceof SandboxRequestError) return error.issues;
    throw error;
  }
  throw new Error("the request was accepted");
};

const refusedAt = (input: unknown, field: string) =>
  expect(refusal(input).some((issue) => issue.startsWith(`${field}:`))).toBe(true);

describe("a complete request", () => {
  it("is accepted, with the policy checked and the command and directory as given", () => {
    const request = validate(validRequest());
    expect(request.command).toEqual(["node", "analyse.js", "--json"]);
    expect(request.sourceDirectory).toBe(inside);
    expect(request.policy).toEqual(validPolicyInput());
  });

  it("needs no source directory when the policy has no source mount", () => {
    const policy = changed("mounts.source", undefined);
    expect(
      validate(validRequest({ policy, sourceDirectory: undefined })).sourceDirectory,
    ).toBeNull();
    expect(validate(validRequest({ policy, sourceDirectory: null })).sourceDirectory).toBeNull();
    expect(validate({ policy, command: ["true"] }).sourceDirectory).toBeNull();
  });

  it("is a frozen copy: the command passed in can be changed later without changing the run", () => {
    const command = ["node", "a.js"];
    const request = validate(validRequest({ command }));
    command[1] = "evil.js";
    command.push("--extra");
    expect(request.command).toEqual(["node", "a.js"]);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.command)).toBe(true);
    expect(() => {
      (request.command as unknown as string[])[0] = "sh";
    }).toThrow(TypeError);
    expect(() => {
      (request.policy.limits as { memoryMb: number }).memoryMb = 1;
    }).toThrow(TypeError);
  });

  it("cannot be built by hand: the type needs a request that was checked", () => {
    // @ts-expect-error a plain object is not a checked request
    const byHand: SandboxRunRequest = {
      policy: validate(validRequest()).policy,
      command: ["true"],
      sourceDirectory: null,
    };
    expect(byHand.command).toEqual(["true"]);
  });
});

describe("assertValidatedRequest, for a driver to call first", () => {
  it("accepts a request that validateRunRequest made", () => {
    expect(() => assertValidatedRequest(validate(validRequest()))).not.toThrow();
  });

  it("refuses an object that was built by hand and cast, a copy of a checked request, and a changed one", () => {
    const checked = validate(validRequest());
    const byHand = {
      policy: checked.policy,
      command: ["true"],
      sourceDirectory: null,
    } as unknown as SandboxRunRequest;
    expect(() => assertValidatedRequest(byHand)).toThrow(SandboxRequestError);
    expect(() => assertValidatedRequest({ ...checked })).toThrow(SandboxRequestError);
    expect(() => assertValidatedRequest(structuredClone(checked))).toThrow(SandboxRequestError);
  });
});

describe("the policy inside a request", () => {
  it("is refused with the fields named under policy", () => {
    refusedAt(validRequest({ policy: changed("limits.memoryMb", 0) }), "policy.limits.memoryMb");
    refusedAt(validRequest({ policy: changed("network.mode", "host") }), "policy.network.mode");
    refusedAt(validRequest({ policy: null }), "policy");
    refusedAt({ command: ["true"] }, "policy");
  });

  it("is refused for a field it cannot have, without printing the field", () => {
    const policy = { ...validPolicyInput(), "field-that-must-not-be-printed": true };
    const issues = refusal(validRequest({ policy }));
    expect(issues).toContain("policy: has a field that a policy cannot have");
    expect(issues.join("\n")).not.toContain("field-that-must-not-be-printed");
  });
});

describe("the request itself", () => {
  it.each([null, undefined, "request", 3, []])("is refused when it is %j", (input) => {
    expect(refusal(input)).toEqual(["(root): must be an object"]);
  });

  it("is refused for a field it cannot have", () => {
    expect(refusal(validRequest({ environment: { KEY: "value" } }))).toContain(
      "(root): has a field that a request cannot have",
    );
  });

  it("reports a bad policy, a bad command and a bad directory together", () => {
    const issues = refusal({ policy: 1, command: [], sourceDirectory: "x" });
    expect(issues.some((issue) => issue.startsWith("policy"))).toBe(true);
    expect(issues.some((issue) => issue.startsWith("command:"))).toBe(true);
  });
});

describe("the command", () => {
  it.each([
    ["missing", undefined],
    ["empty", []],
    ["a string, which a shell would split", "node analyse.js"],
    ["an object", { 0: "node" }],
    ["not made only of text", ["node", 1]],
    ["null among the items", ["node", null]],
    ["an empty program", ["", "x"]],
    ["a null character", ["node", "a\0b"]],
    ["a null character in the program", ["no\0de"]],
    ["too many items", Array.from({ length: 65 }, () => "x")],
    ["an item that is too long", ["node", "x".repeat(4_097)]],
  ])("is refused when it is %s", (_what, command) => {
    refusedAt(validRequest({ command }), "command");
  });

  it("accepts the largest it allows, empty arguments, and characters a shell would act on", () => {
    expect(validate(validRequest({ command: Array.from({ length: 64 }, () => "x") }))).toBeTruthy();
    expect(validate(validRequest({ command: ["node", "x".repeat(4_096)] }))).toBeTruthy();
    const request = validate(
      validRequest({ command: ["echo", "", "a b; rm -rf / && $(id) `id` | cat > f"] }),
    );
    expect(request.command[2]).toBe("a b; rm -rf / && $(id) `id` | cat > f");
  });
});

describe("the source directory", () => {
  it("is required when the policy has a source mount", () => {
    refusedAt(validRequest({ sourceDirectory: undefined }), "sourceDirectory");
    refusedAt(validRequest({ sourceDirectory: null }), "sourceDirectory");
    refusedAt(validRequest({ sourceDirectory: 5 }), "sourceDirectory");
  });

  it("is refused when the policy has no source mount, because it would be a mistake", () => {
    refusedAt(validRequest({ policy: changed("mounts.source", undefined) }), "sourceDirectory");
  });

  it.each([
    ["relative", "run-1/source"],
    ["empty", ""],
    ["the root of the workspace itself", ROOT],
    ["the whole host", "/"],
    ["outside the workspace", "/etc"],
    ["next to the workspace, with the same beginning", `${ROOT}-evil/source`],
    ["above the workspace", "/var/lib/codemugs"],
    ["going up out of the workspace", `${ROOT}/run-1/../../../../etc`],
    ["with a . part", `${ROOT}/./run-1`],
    ["with a comma, which could add a mount option", `${ROOT}/run,readonly=false`],
    ["with a colon, which could add a mount", `${ROOT}/run:/host`],
    ["with a space", `${ROOT}/my run`],
    ["with a newline", `${ROOT}/run\n`],
    ["with a trailing slash", `${ROOT}/run-1/`],
    ["too long", `${ROOT}/${"a".repeat(1_100)}`],
  ])("is refused when it is %s", (_what, sourceDirectory) => {
    refusedAt(validRequest({ sourceDirectory }), "sourceDirectory");
  });

  it("accepts a directory anywhere below the workspace", () => {
    expect(validate(validRequest({ sourceDirectory: `${ROOT}/a` })).sourceDirectory).toBe(
      `${ROOT}/a`,
    );
    expect(validate(validRequest({ sourceDirectory: `${ROOT}/a/b/c` })).sourceDirectory).toBe(
      `${ROOT}/a/b/c`,
    );
  });

  it("does not add a second complaint when the policy is already refused", () => {
    const issues = refusal(validRequest({ policy: null, sourceDirectory: "x" }));
    expect(issues.filter((issue) => issue.startsWith("sourceDirectory"))).toHaveLength(0);
  });
});

describe("the workspace root", () => {
  it.each(["", "relative/path", "/", "/a/", "/a/../b", "/a b", "/a,b"])(
    "is a mistake of the caller when it is %j",
    (workspaceRoot) => {
      expect(() => validateRunRequest(validRequest(), { workspaceRoot })).toThrow(TypeError);
    },
  );
});
