/** What the shop says about itself: a name, a time and some details. */
export interface TelemetryEvent {
  /** Dot-separated and lowercase, such as `order.created`. */
  readonly type: string;
  /** ISO 8601, in UTC. */
  readonly occurredAt: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface Telemetry {
  emit(type: string, attributes?: Readonly<Record<string, unknown>>): void;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Keeps the events in memory, for tests and for the harness that drives the shop. */
export class MemoryTelemetry implements Telemetry {
  readonly events: TelemetryEvent[] = [];
  readonly #clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  emit(type: string, attributes: Readonly<Record<string, unknown>> = {}): void {
    this.events.push({ type, occurredAt: this.#clock.now().toISOString(), attributes });
  }
}

/** One JSON object per line on standard output, which is what a log collector reads. */
export class JsonLinesTelemetry implements Telemetry {
  readonly #clock: Clock;
  readonly #write: (line: string) => void;

  constructor(write: (line: string) => void, clock: Clock = systemClock) {
    this.#write = write;
    this.#clock = clock;
  }

  emit(type: string, attributes: Readonly<Record<string, unknown>> = {}): void {
    const event: TelemetryEvent = { type, occurredAt: this.#clock.now().toISOString(), attributes };
    this.#write(JSON.stringify(event));
  }
}
