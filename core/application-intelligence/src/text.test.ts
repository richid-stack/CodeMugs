import { describe, expect, it } from "vitest";
import { hasControlCharacter } from "./text.js";

describe("hasControlCharacter", () => {
  it("is true for every C0 control, DEL, every C1 control, and the two line separators", () => {
    const codes = [
      ...Array.from({ length: 0x20 }, (_, code) => code),
      ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
      0x2028,
      0x2029,
    ];
    for (const code of codes) {
      expect(hasControlCharacter(`a${String.fromCharCode(code)}b`), code.toString(16)).toBe(true);
    }
  });

  it("is false next to each of those, and for text that has none", () => {
    for (const code of [0x20, 0x7e, 0xa0, 0xa1, 0x2027, 0x202a, 0xfeff]) {
      expect(hasControlCharacter(`a${String.fromCharCode(code)}b`), code.toString(16)).toBe(false);
    }
    expect(hasControlCharacter("")).toBe(false);
    expect(hasControlCharacter("plain/path with spaces.ts")).toBe(false);
    expect(hasControlCharacter("ünï/файл/日本語/😀")).toBe(false);
  });

  it("finds one at the start, in the middle and at the end", () => {
    expect(hasControlCharacter("\nab")).toBe(true);
    expect(hasControlCharacter("a\nb")).toBe(true);
    expect(hasControlCharacter("ab\n")).toBe(true);
    expect(hasControlCharacter("\u0000")).toBe(true);
  });
});
