import { describe, expect, it } from "vitest";
import {
  isolationAtLeast,
  SandboxError,
  type IsolationLevel,
  type SandboxErrorCode,
} from "./driver.js";

const LEVELS: IsolationLevel[] = ["hardened-container", "gvisor", "microvm"];

describe("isolationAtLeast", () => {
  it.each([
    ["hardened-container", "hardened-container", true],
    ["hardened-container", "gvisor", false],
    ["hardened-container", "microvm", false],
    ["gvisor", "hardened-container", true],
    ["gvisor", "gvisor", true],
    ["gvisor", "microvm", false],
    ["microvm", "hardened-container", true],
    ["microvm", "gvisor", true],
    ["microvm", "microvm", true],
  ] as const)("%s against a requirement of %s is %s", (actual, required, expected) => {
    expect(isolationAtLeast(actual, required)).toBe(expected);
  });

  it("covers every level", () => {
    expect(LEVELS).toHaveLength(3);
    for (const level of LEVELS) expect(isolationAtLeast(level, level)).toBe(true);
  });
});

describe("SandboxError", () => {
  const codes: SandboxErrorCode[] = ["unavailable", "start_failed", "cleanup_failed"];

  it.each(codes)("%s has a fixed sentence and carries the code", (code) => {
    const error = new SandboxError(code);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SandboxError");
    expect(error.code).toBe(code);
    expect(error.message).toMatch(/^the sandbox( driver)? (is|could) not /);
  });

  it("says something different for each code", () => {
    expect(new Set(codes.map((code) => new SandboxError(code).message)).size).toBe(codes.length);
  });
});
