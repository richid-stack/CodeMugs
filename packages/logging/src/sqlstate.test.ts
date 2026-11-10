import { describe, expect, it } from "vitest";
import { sqlstateOf } from "./sqlstate.js";

describe("sqlstateOf", () => {
  it("accepts a SQLSTATE: five digits or capitals, with a digit", () => {
    for (const code of ["23505", "42P01", "57P01", "28P01", "P0001", "08006"]) {
      expect(sqlstateOf(Object.assign(new Error("x"), { code }))).toBe(code);
    }
  });

  it("does not take a Node system error code, or anything else, for one", () => {
    for (const code of ["EPERM", "ECONNRESET", "ABCDE", "4250", "425000", "42p01", "", 42, null]) {
      expect(sqlstateOf(Object.assign(new Error("x"), { code }))).toBeUndefined();
    }
    expect(sqlstateOf(new Error("x"))).toBeUndefined();
    expect(sqlstateOf("23505")).toBeUndefined();
    expect(sqlstateOf(undefined)).toBeUndefined();
  });
});
