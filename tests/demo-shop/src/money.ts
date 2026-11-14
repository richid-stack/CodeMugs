/** Money is a whole number of cents, always. There are no fractions of a cent anywhere. */
export type Cents = number;

/**
 * `basisPoints` of `amount`, rounded half up: 1 000 basis points is 10%. It is for amounts that
 * are not negative, and does everything in whole numbers so that no rounding error creeps in.
 */
export function basisPointsOf(amount: Cents, basisPoints: number): Cents {
  return Math.floor((amount * basisPoints + 5_000) / 10_000);
}

/** 1299 -> "12.99". For people to read, never to calculate with. */
export function formatCents(amount: Cents): string {
  const sign = amount < 0 ? "-" : "";
  const absolute = Math.abs(amount);
  const whole = Math.floor(absolute / 100);
  const cents = String(absolute % 100).padStart(2, "0");
  return `${sign}${whole}.${cents}`;
}
