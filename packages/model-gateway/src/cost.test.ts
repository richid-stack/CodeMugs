import { describe, expect, it } from "vitest";
import { costMicros, estimateTokens, isValidPrice } from "./cost.js";

const price = { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 };

describe("the cost of a call", () => {
  it("is the tokens of each kind at its price, in millionths of a dollar", () => {
    expect(costMicros(1_000_000, 0, price)).toBe(3_000_000);
    expect(costMicros(0, 1_000_000, price)).toBe(15_000_000);
    expect(costMicros(2_000, 500, price)).toBe(6_000 + 7_500);
    expect(costMicros(0, 0, price)).toBe(0);
  });

  it("rounds each part up, so that it is never less than the charge", () => {
    expect(costMicros(1, 0, price)).toBe(3);
    expect(
      costMicros(1, 1, { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 }),
    ).toBe(2);
    expect(
      costMicros(333_333, 0, { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 0 }),
    ).toBe(1);
  });

  it("is exact where a float would not be: a product that is past 2^53", () => {
    const huge = { inputMicrosPerMillionTokens: 1_000_000_000, outputMicrosPerMillionTokens: 0 };
    // 9 billion tokens at a thousand dollars a million: the product is 9.007e18, far past 2^53, where a float is no longer exact.
    expect(costMicros(9_007_199_254, 0, huge)).toBe(9_007_199_254_000);
  });

  it("refuses what is not a whole number that is not negative", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => costMicros(bad, 0, price)).toThrow(RangeError);
      expect(() => costMicros(0, bad, price)).toThrow(RangeError);
      expect(() => costMicros(1, 1, { ...price, inputMicrosPerMillionTokens: bad })).toThrow(
        RangeError,
      );
      expect(() => costMicros(1, 1, { ...price, outputMicrosPerMillionTokens: bad })).toThrow(
        RangeError,
      );
    }
  });

  it("refuses a cost that is too large to be a safe integer", () => {
    const huge = {
      inputMicrosPerMillionTokens: Number.MAX_SAFE_INTEGER,
      outputMicrosPerMillionTokens: 0,
    };
    expect(() => costMicros(Number.MAX_SAFE_INTEGER, 0, huge)).toThrow(RangeError);
  });

  it("says whether a price is whole numbers", () => {
    expect(isValidPrice(price)).toBe(true);
    expect(isValidPrice({ ...price, inputMicrosPerMillionTokens: 0.5 })).toBe(false);
    expect(isValidPrice({ ...price, outputMicrosPerMillionTokens: -1 })).toBe(false);
  });
});

describe("the guess of the tokens in a text", () => {
  it("is three ASCII characters to a token, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("x".repeat(300))).toBe(100);
  });

  it("is two tokens for every character outside ASCII, which Chinese, Japanese and Korean text can need", () => {
    expect(estimateTokens("日本語")).toBe(6);
    expect(estimateTokens("é")).toBe(2);
    expect(estimateTokens("abc日本")).toBe(1 + 4);
    // An emoji is two UTF-16 code units, so four, and no text is taken for less than it is.
    expect(estimateTokens("😀")).toBe(4);
  });
});
