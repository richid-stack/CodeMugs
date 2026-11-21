import { describe, expect, it } from "vitest";
import { IdentityError } from "./errors.js";
import { API_KEY_SCOPES, DEFAULT_API_KEY_SCOPES, checkScopes, knownScopes } from "./scopes.js";

const code = (work: () => unknown): string | undefined => {
  try {
    work();
  } catch (error) {
    return error instanceof IdentityError ? error.code : "other";
  }
  return undefined;
};

describe("checkScopes", () => {
  it("is what a key could always do when no scopes are named", () => {
    expect(checkScopes(undefined)).toEqual(["events:write"]);
    expect(checkScopes(undefined)).toBe(DEFAULT_API_KEY_SCOPES);
  });

  it("keeps what is named, once each, in the order of the list of scopes", () => {
    expect(checkScopes(["analysis:write", "events:write", "analysis:write"])).toEqual([
      "events:write",
      "analysis:write",
    ]);
    expect(checkScopes([...API_KEY_SCOPES].reverse())).toEqual([...API_KEY_SCOPES]);
  });

  it.each([
    [[]],
    [["admin"]],
    [["events:write", "admin"]],
    [["EVENTS:WRITE"]],
    [["events:write "]],
    [["*"]],
    [[""]],
    ["events:write"],
    [[1, "events:write"]],
    [[null]],
    [{ 0: "events:write", length: 1 }],
  ])("refuses %j", (value) => {
    expect(code(() => checkScopes(value as never))).toBe("invalid_scopes");
  });

  it("says the same fixed thing for every refusal, and nothing of what was given", () => {
    try {
      checkScopes(["billing:secret-value"]);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe("scopes must be a list of one or more known scopes");
    }
  });

  it("does not let the list that it gives back be changed into a wider one", () => {
    expect(Object.isFrozen(DEFAULT_API_KEY_SCOPES)).toBe(true);
  });
});

describe("knownScopes", () => {
  it("gives the known scopes of what was stored, in order", () => {
    expect(knownScopes(["analysis:read", "events:write"])).toEqual([
      "events:write",
      "analysis:read",
    ]);
  });

  it("drops what it does not know, and gives nothing for what is not a list", () => {
    expect(knownScopes(["analysis:read", "billing:admin"])).toEqual(["analysis:read"]);
    for (const value of [null, undefined, "events:write", 1, {}]) {
      expect(knownScopes(value)).toEqual([]);
    }
  });
});
