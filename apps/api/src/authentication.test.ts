import { describe, expect, it } from "vitest";
import { bearerToken } from "./authentication.js";

describe("bearerToken", () => {
  it.each([
    ["Bearer abc123", "abc123"],
    ["bearer abc123", "abc123"],
    ["BEARER abc123", "abc123"],
    ["Bearer a-b_c.d~e+f/g=", "a-b_c.d~e+f/g="],
  ])("takes the token from %j", (header, token) => {
    expect(bearerToken(header)).toBe(token);
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["a scheme with no token", "Bearer"],
    ["a scheme with a space and no token", "Bearer "],
    ["two spaces before the token", "Bearer  abc123"],
    ["two tokens", "Bearer abc 123"],
    ["a trailing space", "Bearer abc123 "],
    ["a leading space", " Bearer abc123"],
    ["a newline in the token", "Bearer abc\n123"],
    ["a tab instead of a space", "Bearer\tabc123"],
    ["another scheme", "Basic abc123"],
    ["a scheme glued to the token", "Bearerabc123"],
    ["a token over the length cap", `Bearer ${"a".repeat(513)}`],
  ])("rejects %s", (_label, header) => {
    expect(bearerToken(header)).toBeUndefined();
  });

  it("accepts a token exactly at the length cap", () => {
    expect(bearerToken(`Bearer ${"a".repeat(512)}`)).toHaveLength(512);
  });
});
