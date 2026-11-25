export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerStatus {
  readonly state: BreakerState;
  readonly consecutiveFailures: number;
}

/**
 * A circuit breaker for one provider. It counts failures in a row that are the provider's (it could not
 * be reached, it limited the requests, it was too slow); after `failureThreshold` of them it opens and
 * the provider is not called for `cooldownMs`, so that a provider that is down is not made to wait for
 * every call and is not hit while it recovers. After the cooldown it lets **one** call through (half
 * open) to find out: if that works it closes, and if it fails it opens again for another cooldown.
 * Other calls that come while the probe is out do not go to the provider.
 */
export class CircuitBreaker {
  private state: BreakerState = "closed";
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number,
  ) {}

  /** Whether a call may be made to the provider now. A `true` for a half-open breaker takes its one probe. */
  tryAcquire(): boolean {
    if (this.state === "open") {
      if (this.now() - this.openedAt < this.cooldownMs) return false;
      this.state = "half_open";
      this.probing = true;
      return true;
    }
    if (this.state === "half_open") {
      if (this.probing) return false;
      this.probing = true;
      return true;
    }
    return true;
  }

  /** The provider answered, whatever the answer was worth: it is reachable. */
  success(): void {
    this.state = "closed";
    this.failures = 0;
    this.probing = false;
  }

  /** The provider failed in a way that is its own. */
  failure(): void {
    // A late result from a call that began before the breaker opened says nothing new.
    if (this.state === "open") return;
    if (this.state === "half_open") {
      this.open();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.open();
  }

  /** The call ended without saying anything about the provider (the caller left), so the probe, if it was one, is free again. */
  release(): void {
    this.probing = false;
  }

  status(): BreakerStatus {
    const ready = this.state === "open" && this.now() - this.openedAt >= this.cooldownMs;
    return { state: ready ? "half_open" : this.state, consecutiveFailures: this.failures };
  }

  private open(): void {
    this.state = "open";
    this.openedAt = this.now();
    this.probing = false;
  }
}
