import type * as Crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// The real generator, watched: what it is asked for is checked as well as what it returns.
const drawn = vi.hoisted(() => ({ calls: [] as Array<[number, number]> }));
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof Crypto>();
  return {
    ...original,
    randomInt: ((min: number, max: number) => {
      drawn.calls.push([min, max]);
      return original.randomInt(min, max);
    }) as typeof original.randomInt,
  };
});

import { FIRST_RUN_ID, isRunUser, LAST_RUN_ID, newRunUser } from "./run-user.js";

describe("the user of a run", () => {
  it("has a user id and a group id that are the same whole number, in the range", () => {
    for (let n = 0; n < 500; n++) {
      const user = newRunUser();
      expect(Number.isSafeInteger(user.uid)).toBe(true);
      expect(user.gid).toBe(user.uid);
      expect(user.uid).toBeGreaterThanOrEqual(FIRST_RUN_ID);
      expect(user.uid).toBeLessThanOrEqual(LAST_RUN_ID);
      expect(isRunUser(user)).toBe(true);
    }
  });

  it("is above the ranges that systemd documents for users, and below 2^31", () => {
    // The range is a decision (ADR 0021), so the numbers are written out and a change shows here.
    expect(FIRST_RUN_ID).toBe(1_900_000_000);
    expect(LAST_RUN_ID).toBe(2_099_999_999);
    expect(FIRST_RUN_ID).toBeGreaterThan(1_879_048_191);
    expect(LAST_RUN_ID).toBeLessThan(2 ** 31);
    expect(FIRST_RUN_ID).toBeLessThan(LAST_RUN_ID);
  });

  it("is drawn from the whole range, with the top included, by the system's random numbers", () => {
    drawn.calls.length = 0;
    newRunUser();
    // `randomInt` leaves out its upper bound, so the range's top needs one more.
    expect(drawn.calls).toEqual([[FIRST_RUN_ID, LAST_RUN_ID + 1]]);
  });

  it("is not the same every time", () => {
    // Twenty draws from two hundred million are not all alike unless the draw is broken.
    const ids = new Set(Array.from({ length: 20 }, () => newRunUser().uid));
    expect(ids.size).toBeGreaterThan(1);
  });

  it("is a user that isRunUser accepts, and isRunUser refuses what is outside the range", () => {
    expect(isRunUser({ uid: FIRST_RUN_ID, gid: LAST_RUN_ID })).toBe(true);
    for (const id of [
      0,
      1,
      65_534,
      FIRST_RUN_ID - 1,
      LAST_RUN_ID + 1,
      2 ** 31,
      2 ** 32,
      -1,
      1.5,
      // In the range, and not a whole number.
      FIRST_RUN_ID + 0.5,
    ]) {
      expect(isRunUser({ uid: id, gid: FIRST_RUN_ID })).toBe(false);
      expect(isRunUser({ uid: FIRST_RUN_ID, gid: id })).toBe(false);
    }
    expect(isRunUser({ uid: Number.NaN, gid: FIRST_RUN_ID })).toBe(false);
    expect(isRunUser({ uid: FIRST_RUN_ID, gid: Number.POSITIVE_INFINITY })).toBe(false);
  });
});
