import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "./breaker.js";

function breakerWith(failureThreshold = 3, cooldownMs = 1_000) {
  const clock = { now: 10_000 };
  const breaker = new CircuitBreaker(failureThreshold, cooldownMs, () => clock.now);
  return { breaker, clock };
}

describe("the circuit breaker of a provider", () => {
  it("lets every call through while it is closed, and stays closed below the threshold", () => {
    const { breaker } = breakerWith(3);
    expect(breaker.status()).toEqual({ state: "closed", consecutiveFailures: 0 });
    breaker.failure();
    breaker.failure();
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.status()).toEqual({ state: "closed", consecutiveFailures: 2 });
  });

  it("opens at the threshold, and refuses every call until the cooldown is over", () => {
    const { breaker, clock } = breakerWith(3, 1_000);
    for (let i = 0; i < 3; i += 1) breaker.failure();
    expect(breaker.status().state).toBe("open");
    expect(breaker.tryAcquire()).toBe(false);
    clock.now += 999;
    expect(breaker.tryAcquire()).toBe(false);
    clock.now += 1;
    expect(breaker.tryAcquire()).toBe(true);
  });

  it("counts failures in a row, so that a success in between starts the count again", () => {
    const { breaker } = breakerWith(3);
    breaker.failure();
    breaker.failure();
    breaker.success();
    breaker.failure();
    breaker.failure();
    expect(breaker.status()).toEqual({ state: "closed", consecutiveFailures: 2 });
    breaker.failure();
    expect(breaker.status().state).toBe("open");
  });

  it("lets one call through after the cooldown, and refuses the others while it is out", () => {
    const { breaker, clock } = breakerWith(1, 1_000);
    breaker.failure();
    clock.now += 1_000;
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.status().state).toBe("half_open");
    expect(breaker.tryAcquire()).toBe(false);
    expect(breaker.tryAcquire()).toBe(false);
  });

  it("closes when the probe works, and is then a breaker with no failures", () => {
    const { breaker, clock } = breakerWith(2, 1_000);
    breaker.failure();
    breaker.failure();
    clock.now += 1_000;
    expect(breaker.tryAcquire()).toBe(true);
    breaker.success();
    expect(breaker.status()).toEqual({ state: "closed", consecutiveFailures: 0 });
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.failure();
    expect(breaker.status().state).toBe("closed");
  });

  it("opens again for a whole cooldown, counted from then, when the probe fails", () => {
    const { breaker, clock } = breakerWith(1, 1_000);
    breaker.failure();
    clock.now += 1_000;
    expect(breaker.tryAcquire()).toBe(true);
    clock.now += 300;
    breaker.failure();
    expect(breaker.status().state).toBe("open");
    clock.now += 999;
    expect(breaker.tryAcquire()).toBe(false);
    clock.now += 1;
    expect(breaker.tryAcquire()).toBe(true);
  });

  it("frees the probe, and stays half open, when a call ends without saying anything about the provider", () => {
    const { breaker, clock } = breakerWith(1, 1_000);
    breaker.failure();
    clock.now += 1_000;
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
    breaker.release();
    expect(breaker.status().state).toBe("half_open");
    expect(breaker.tryAcquire()).toBe(true);
  });

  it("is not made to wait longer by a late failure from a call that began before it opened", () => {
    const { breaker, clock } = breakerWith(1, 1_000);
    breaker.failure();
    clock.now += 800;
    breaker.failure();
    clock.now += 200;
    expect(breaker.tryAcquire()).toBe(true);
  });

  it("says that it is half open once the cooldown is over, before anyone has asked", () => {
    const { breaker, clock } = breakerWith(1, 1_000);
    breaker.failure();
    expect(breaker.status()).toEqual({ state: "open", consecutiveFailures: 1 });
    clock.now += 1_000;
    expect(breaker.status().state).toBe("half_open");
    // Looking is not asking: the probe is still there to be taken.
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
  });
});
