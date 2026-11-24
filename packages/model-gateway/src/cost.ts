import type { ProviderPrice } from "./types.js";

const MILLION = 1_000_000n;

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Whether a price is whole, non-negative numbers (the gateway refuses a provider whose is not). */
export function isValidPrice(price: ProviderPrice): boolean {
  return isCount(price.inputMicrosPerMillionTokens) && isCount(price.outputMicrosPerMillionTokens);
}

/**
 * What a call cost, in millionths of a dollar, rounded up for each of the two parts so that the
 * total is never less than what the provider will charge. In whole numbers, with no float, and with
 * BigInt for the products, which can pass 2^53 for a large call at a high price.
 */
export function costMicros(
  inputTokens: number,
  outputTokens: number,
  price: ProviderPrice,
): number {
  if (!isCount(inputTokens) || !isCount(outputTokens) || !isValidPrice(price)) {
    throw new RangeError("tokens and prices must be whole numbers that are not negative");
  }
  const part = (tokens: number, perMillion: number): bigint =>
    (BigInt(tokens) * BigInt(perMillion) + MILLION - 1n) / MILLION;
  const total =
    part(inputTokens, price.inputMicrosPerMillionTokens) +
    part(outputTokens, price.outputMicrosPerMillionTokens);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("the cost is too large");
  return Number(total);
}

/**
 * A guess of the tokens in some text, for deciding whether a request fits a provider before it is
 * sent: three characters to a token, which is more than most text needs, so that the guess errs
 * towards "too big" and not towards a call that the provider refuses. The provider's own count is
 * what is accounted.
 */
export function estimateTokens(characters: number): number {
  return Math.ceil(characters / 3);
}
