import { describe, expect, it } from "vitest";
import { postgresErrorCode } from "./errors.js";

describe("postgresErrorCode", () => {
  it("returns the SQLSTATE of a database error", () => {
    expect(postgresErrorCode(Object.assign(new Error("duplicate"), { code: "23505" }))).toBe(
      "23505",
    );
    expect(postgresErrorCode({ code: "42P01" })).toBe("42P01");
  });

  it.each([
    ["a plain error", new Error("no code")],
    ["null", null],
    ["undefined", undefined],
    ["a string", "23505"],
    ["a numeric code", { code: 23505 }],
    ["a system error code", Object.assign(new Error("refused"), { code: "ECONNREFUSED" })],
    ["a five-letter system error code", Object.assign(new Error("denied"), { code: "EPERM" })],
    ["a lower-case code", { code: "abcde" }],
  ])("returns undefined for %s", (_label, value) => {
    expect(postgresErrorCode(value)).toBeUndefined();
  });
});
