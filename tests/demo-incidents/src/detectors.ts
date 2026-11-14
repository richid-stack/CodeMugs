/** What the demo shop says about itself (tests/demo-shop/src/telemetry.ts), as this package reads it. */
export interface TelemetryEvent {
  readonly type: string;
  readonly occurredAt: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export const DETECTOR_NAMES = [
  "crashes-on-request",
  "oversold-stock",
  "pages-miss-orders",
  "duplicate-orders",
  "negative-total",
] as const;

export type DetectorName = (typeof DETECTOR_NAMES)[number];

export interface Finding {
  readonly detector: DetectorName;
  readonly details: Readonly<Record<string, unknown>>;
}

type Detector = (events: readonly TelemetryEvent[]) => Finding[];

function ofType(events: readonly TelemetryEvent[], type: string): TelemetryEvent[] {
  return events.filter((event) => event.type === type);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function whole(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * A shop that is well does not throw. Every kind of error it captured is a finding, with how many
 * times it happened.
 */
const crashesOnRequest: Detector = (events) => {
  const kinds = new Map<string, { name: string; message: string; path: string; count: number }>();
  for (const event of ofType(events, "error.captured")) {
    const name = text(event.attributes["name"]);
    const message = text(event.attributes["message"]);
    const path = text(event.attributes["path"]);
    const key = JSON.stringify([name, message, path]);
    const known = kinds.get(key);
    if (known === undefined) kinds.set(key, { name, message, path, count: 1 });
    else known.count += 1;
  }
  return [...kinds.values()].map((details) => ({ detector: "crashes-on-request", details }));
};

/** More units held by orders than the shop started with: what was reserved, less what was given back. */
const oversoldStock: Detector = (events) => {
  const stocked = new Map<string, number>();
  const held = new Map<string, number>();
  for (const event of ofType(events, "inventory.stocked")) {
    const sku = text(event.attributes["sku"]);
    stocked.set(sku, (stocked.get(sku) ?? 0) + whole(event.attributes["quantity"]));
  }
  for (const event of ofType(events, "inventory.reserved")) {
    const sku = text(event.attributes["sku"]);
    held.set(sku, (held.get(sku) ?? 0) + whole(event.attributes["quantity"]));
  }
  for (const event of ofType(events, "inventory.released")) {
    const sku = text(event.attributes["sku"]);
    held.set(sku, (held.get(sku) ?? 0) - whole(event.attributes["quantity"]));
  }
  const findings: Finding[] = [];
  for (const [sku, units] of held) {
    const started = stocked.get(sku) ?? 0;
    if (units > started)
      findings.push({ detector: "oversold-stock", details: { sku, started, held: units } });
  }
  return findings.sort((a, b) => text(a.details["sku"]).localeCompare(text(b.details["sku"])));
};

/**
 * A customer whose orders were listed page by page, from the first page to the last, and whose pages
 * held fewer or more orders in all than the shop says there are.
 */
const pagesMissOrders: Detector = (events) => {
  const walks = new Map<
    string,
    { customerId: string; pageSize: number; total: number; pages: Map<number, number> }
  >();
  for (const event of ofType(events, "orders.listed")) {
    const customerId = text(event.attributes["customerId"]);
    const pageSize = whole(event.attributes["pageSize"]);
    const total = whole(event.attributes["total"]);
    const key = JSON.stringify([customerId, pageSize, total]);
    const walk = walks.get(key) ?? {
      customerId,
      pageSize,
      total,
      pages: new Map<number, number>(),
    };
    walk.pages.set(whole(event.attributes["page"]), whole(event.attributes["returned"]));
    walks.set(key, walk);
  }
  const findings: Finding[] = [];
  for (const { customerId, pageSize, total, pages } of walks.values()) {
    // Telemetry is untrusted, so a size that makes no sense is not judged, and what is done is
    // bounded by the events and not by the numbers in them.
    if (!Number.isInteger(pageSize) || pageSize < 1 || !Number.isInteger(total) || total < 0) {
      continue;
    }
    const last = Math.ceil(total / pageSize);
    let seen = 0;
    let returned = 0;
    for (const [page, count] of pages) {
      if (Number.isInteger(page) && page >= 1 && page <= last) {
        seen += 1;
        returned += count;
      }
    }
    if (seen === last && returned !== total) {
      findings.push({
        detector: "pages-miss-orders",
        details: { customerId, pageSize, total, returned },
      });
    }
  }
  return findings.sort((a, b) =>
    JSON.stringify(a.details).localeCompare(JSON.stringify(b.details)),
  );
};

/** Two orders made by one customer with one idempotency key. */
const duplicateOrders: Detector = (events) => {
  const counts = new Map<
    string,
    { customerId: string; idempotencyKey: string; orders: string[] }
  >();
  for (const event of ofType(events, "order.created")) {
    const key = event.attributes["idempotencyKey"];
    if (typeof key !== "string") continue;
    const customerId = text(event.attributes["customerId"]);
    const id = JSON.stringify([customerId, key]);
    const entry = counts.get(id) ?? { customerId, idempotencyKey: key, orders: [] };
    entry.orders.push(text(event.attributes["orderId"]));
    counts.set(id, entry);
  }
  return [...counts.values()]
    .filter((entry) => entry.orders.length > 1)
    .map((entry) => ({
      detector: "duplicate-orders" as const,
      details: {
        customerId: entry.customerId,
        idempotencyKey: entry.idempotencyKey,
        orders: entry.orders.sort(),
      },
    }))
    .sort((a, b) => JSON.stringify(a.details).localeCompare(JSON.stringify(b.details)));
};

/** An order that costs less than nothing. */
const negativeTotal: Detector = (events) =>
  ofType(events, "order.created")
    .filter((event) => whole(event.attributes["totalCents"]) < 0)
    .map((event) => ({
      detector: "negative-total" as const,
      details: {
        orderId: text(event.attributes["orderId"]),
        totalCents: whole(event.attributes["totalCents"]),
        subtotalCents: whole(event.attributes["subtotalCents"]),
        discountCents: whole(event.attributes["discountCents"]),
      },
    }))
    .sort((a, b) => text(a.details["orderId"]).localeCompare(text(b.details["orderId"])));

export const DETECTORS: Readonly<Record<DetectorName, Detector>> = {
  "crashes-on-request": crashesOnRequest,
  "oversold-stock": oversoldStock,
  "pages-miss-orders": pagesMissOrders,
  "duplicate-orders": duplicateOrders,
  "negative-total": negativeTotal,
};

/** Everything that every detector finds in the events. */
export function detectAll(events: readonly TelemetryEvent[]): Finding[] {
  return DETECTOR_NAMES.flatMap((name) => DETECTORS[name](events));
}
