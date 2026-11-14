import { describe, expect, it } from "vitest";
import { DETECTOR_NAMES, DETECTORS, detectAll, type TelemetryEvent } from "./detectors.js";

let clock = 0;
function event(type: string, attributes: Record<string, unknown>): TelemetryEvent {
  clock += 1;
  return {
    type,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString(),
    attributes,
  };
}

const stocked = (sku: string, quantity: number): TelemetryEvent =>
  event("inventory.stocked", { sku, quantity });
const reserved = (sku: string, quantity: number): TelemetryEvent =>
  event("inventory.reserved", { sku, quantity });
const released = (sku: string, quantity: number): TelemetryEvent =>
  event("inventory.released", { sku, quantity });
const listed = (
  customerId: string,
  page: number,
  pageSize: number,
  returned: number,
  total: number,
): TelemetryEvent => event("orders.listed", { customerId, page, pageSize, returned, total });
const created = (attributes: Record<string, unknown>): TelemetryEvent =>
  event("order.created", attributes);

describe("the detectors", () => {
  it("are one for each name, in the order of the names", () => {
    expect(Object.keys(DETECTORS)).toEqual([...DETECTOR_NAMES]);
  });

  it("find nothing in no events", () => {
    expect(detectAll([])).toEqual([]);
  });

  it("find nothing in events of kinds that no detector reads", () => {
    expect(detectAll([event("shop.started", {}), event("http.request", { status: 500 })])).toEqual(
      [],
    );
  });
});

describe("crashes-on-request", () => {
  const detect = DETECTORS["crashes-on-request"];
  const crash = (name: string, message: string, path: string): TelemetryEvent =>
    event("error.captured", { name, message, path });

  it("reports an error that was captured", () => {
    expect(detect([crash("TypeError", "x is undefined", "/orders")])).toEqual([
      {
        detector: "crashes-on-request",
        details: { name: "TypeError", message: "x is undefined", path: "/orders", count: 1 },
      },
    ]);
  });

  it("counts the same error, and keeps errors that differ apart", () => {
    const found = detect([
      crash("TypeError", "x", "/orders"),
      crash("TypeError", "x", "/orders"),
      crash("TypeError", "x", "/products"),
      crash("RangeError", "x", "/orders"),
      crash("TypeError", "y", "/orders"),
    ]);
    expect(found.map((finding) => finding.details["count"])).toEqual([2, 1, 1, 1]);
  });

  it("does not take a name, a message and a path that run together for one error", () => {
    expect(detect([crash("A\nB", "C", "/p"), crash("A", "B\nC", "/p")])).toHaveLength(2);
  });

  it("reports an event with no attributes it knows, as an error with empty fields", () => {
    expect(detect([event("error.captured", { name: 4 })])).toEqual([
      {
        detector: "crashes-on-request",
        details: { name: "", message: "", path: "", count: 1 },
      },
    ]);
  });
});

describe("oversold-stock", () => {
  const detect = DETECTORS["oversold-stock"];

  it("is quiet when what is held is what was stocked, or less", () => {
    expect(detect([stocked("A", 3), reserved("A", 3)])).toEqual([]);
    expect(detect([stocked("A", 3), reserved("A", 1)])).toEqual([]);
  });

  it("reports one unit more than was stocked, with both numbers", () => {
    expect(detect([stocked("A", 3), reserved("A", 2), reserved("A", 2)])).toEqual([
      { detector: "oversold-stock", details: { sku: "A", started: 3, held: 4 } },
    ]);
  });

  it("adds up the stock that was added and the reservations that were made", () => {
    expect(
      detect([
        stocked("A", 1),
        stocked("A", 2),
        reserved("A", 1),
        reserved("A", 1),
        reserved("A", 1),
      ]),
    ).toEqual([]);
    expect(
      detect([stocked("A", 1), stocked("A", 2), reserved("A", 2), reserved("A", 2)]),
    ).toHaveLength(1);
  });

  it("takes off what was given back, so that a failed order that returns its units is no oversale", () => {
    expect(detect([stocked("A", 1), reserved("A", 1), released("A", 1), reserved("A", 1)])).toEqual(
      [],
    );
    expect(detect([stocked("A", 1), reserved("A", 2), released("A", 1)])).toEqual([]);
    expect(detect([stocked("A", 1), reserved("A", 3), released("A", 1)])).toHaveLength(1);
  });

  it("does not report a product whose units were given back and never held", () => {
    expect(detect([stocked("A", 1), released("A", 5)])).toEqual([]);
  });

  it("reports a product that was never stocked as one that started with none", () => {
    expect(detect([reserved("Z", 1)])).toEqual([
      { detector: "oversold-stock", details: { sku: "Z", started: 0, held: 1 } },
    ]);
  });

  it("keeps products apart, and lists the findings in the order of the skus", () => {
    const found = detect([
      stocked("B", 1),
      stocked("A", 1),
      reserved("B", 2),
      reserved("A", 2),
      stocked("C", 5),
      reserved("C", 5),
    ]);
    expect(found.map((finding) => finding.details["sku"])).toEqual(["A", "B"]);
  });

  it("reads a quantity that is not a number as none", () => {
    expect(
      detect([stocked("A", 1), event("inventory.reserved", { sku: "A", quantity: "9" })]),
    ).toEqual([]);
    expect(
      detect([stocked("A", 1), event("inventory.reserved", { sku: "A", quantity: Infinity })]),
    ).toEqual([]);
  });
});

describe("pages-miss-orders", () => {
  const detect = DETECTORS["pages-miss-orders"];
  const walk = (customerId: string, pageSize: number, total: number, returned: number[]) =>
    returned.map((count, index) => listed(customerId, index + 1, pageSize, count, total));

  it("is quiet when the pages add up to the total", () => {
    expect(detect(walk("c", 10, 25, [10, 10, 5]))).toEqual([]);
    expect(detect(walk("c", 10, 20, [10, 10]))).toEqual([]);
    expect(detect(walk("c", 5, 3, [3]))).toEqual([]);
  });

  it("reports a walk whose pages hold fewer orders than the total", () => {
    expect(detect(walk("c", 10, 25, [10, 10, 4]))).toEqual([
      {
        detector: "pages-miss-orders",
        details: { customerId: "c", pageSize: 10, total: 25, returned: 24 },
      },
    ]);
  });

  it("reports a walk whose pages hold more orders than the total", () => {
    expect(detect(walk("c", 10, 25, [10, 10, 6]))).toHaveLength(1);
  });

  it("does not judge a walk that did not reach every page", () => {
    expect(detect(walk("c", 10, 25, [10, 10]))).toEqual([]);
    expect(detect([listed("c", 1, 10, 10, 25), listed("c", 3, 10, 4, 25)])).toEqual([]);
  });

  it("does not judge sizes that make no sense, and does not loop over them", () => {
    expect(
      detect([event("orders.listed", { customerId: "c", page: 1, returned: 1, total: 5 })]),
    ).toEqual([]);
    expect(detect(walk("c", 0, 5, [1]))).toEqual([]);
    expect(detect(walk("c", -10, 5, [1]))).toEqual([]);
    expect(detect(walk("c", 2.5, 5, [2, 2]))).toEqual([]);
    expect(detect(walk("c", 10, -1, [1]))).toEqual([]);
    expect(detect(walk("c", 10, -5, [1]))).toEqual([]);
    expect(detect(walk("c", 10, 2.5, [1]))).toEqual([]);
    // A huge total with a page of one would be a loop of a trillion pages.
    expect(detect(walk("c", 1, 1_000_000_000_000, [1]))).toEqual([]);
  });

  it("does not count a page that is not a whole number, or below the first, or past the last", () => {
    // Each of these would make the pages add up to the wrong total if it were counted as a page.
    expect(detect([listed("c", 1, 10, 10, 12), listed("c", 1.5, 10, 3, 12)])).toEqual([]);
    expect(detect([listed("c", 1, 10, 10, 12), listed("c", 0, 10, 3, 12)])).toEqual([]);
    expect(detect([listed("c", 1, 10, 10, 12), listed("c", 3, 10, 5, 12)])).toEqual([]);
    expect(
      detect([listed("c", 1, 10, 10, 12), listed("c", 2, 10, 2, 12), listed("c", 3, 10, 5, 12)]),
    ).toEqual([]);
  });

  it("does not judge a customer with no orders", () => {
    expect(detect(walk("c", 10, 0, [0]))).toEqual([]);
  });

  it("walks the pages of a customer once for each page size, and the customers apart", () => {
    const events = [
      ...walk("a", 10, 25, [10, 10, 5]),
      ...walk("a", 5, 25, [5, 5, 5, 5, 4]),
      ...walk("b", 10, 25, [10, 10, 5]),
    ];
    expect(detect(events)).toEqual([
      {
        detector: "pages-miss-orders",
        details: { customerId: "a", pageSize: 5, total: 25, returned: 24 },
      },
    ]);
  });

  it("does not add up a page that was read twice", () => {
    expect(detect([...walk("c", 10, 12, [10, 2]), listed("c", 1, 10, 10, 12)])).toEqual([]);
  });

  it("keeps walks apart when the total changed, as when an order came in between", () => {
    expect(detect([listed("c", 1, 10, 10, 11), listed("c", 2, 10, 1, 12)])).toEqual([]);
    // Two complete walks, each right for the total it saw. Run together they would not add up.
    expect(detect([...walk("c", 10, 11, [10, 1]), ...walk("c", 10, 12, [10, 2])])).toEqual([]);
  });

  it("does not take a customer and a page size that run together for one walk", () => {
    expect(detect([...walk("a\n10", 5, 5, [4]), ...walk("a", 10, 5, [4])])).toHaveLength(2);
  });

  it("lists findings in a fixed order", () => {
    const found = detect([...walk("b", 10, 5, [4]), ...walk("a", 10, 5, [4])]);
    expect(found.map((finding) => finding.details["customerId"])).toEqual(["a", "b"]);
  });
});

describe("duplicate-orders", () => {
  const detect = DETECTORS["duplicate-orders"];
  const order = (orderId: string, customerId: string, idempotencyKey: unknown): TelemetryEvent =>
    created({ orderId, customerId, idempotencyKey });

  it("reports two orders made for one customer and one key, with their ids in order", () => {
    expect(detect([order("ord_2", "c", "k"), order("ord_1", "c", "k")])).toEqual([
      {
        detector: "duplicate-orders",
        details: { customerId: "c", idempotencyKey: "k", orders: ["ord_1", "ord_2"] },
      },
    ]);
  });

  it("lists all the orders when there are three", () => {
    const found = detect([order("1", "c", "k"), order("2", "c", "k"), order("3", "c", "k")]);
    expect(found[0]?.details["orders"]).toEqual(["1", "2", "3"]);
  });

  it("is quiet for the same key from two customers, and two keys from one", () => {
    expect(detect([order("1", "a", "k"), order("2", "b", "k")])).toEqual([]);
    expect(detect([order("1", "c", "k1"), order("2", "c", "k2")])).toEqual([]);
  });

  it("does not take a customer and a key that run together for one pair", () => {
    expect(detect([order("1", "a\nb", "c"), order("2", "a", "b\nc")])).toEqual([]);
  });

  it("leaves out an order whose key is not text, however often it is repeated", () => {
    expect(detect([order("1", "c", 7), order("2", "c", 7), order("3", "c", null)])).toEqual([]);
    expect(detect([order("1", "c", null), order("2", "c", null)])).toEqual([]);
  });

  it("leaves out orders that were made without a key", () => {
    expect(
      detect([order("1", "c", undefined), order("2", "c", undefined), order("3", "c", 7)]),
    ).toEqual([]);
    expect(detect([created({ orderId: "1" }), created({ orderId: "2" })])).toEqual([]);
  });

  it("lists findings in a fixed order", () => {
    const found = detect([
      order("1", "b", "k"),
      order("2", "b", "k"),
      order("3", "a", "k"),
      order("4", "a", "k"),
    ]);
    expect(found.map((finding) => finding.details["customerId"])).toEqual(["a", "b"]);
  });
});

describe("negative-total", () => {
  const detect = DETECTORS["negative-total"];
  const priced = (orderId: string, totalCents: unknown): TelemetryEvent =>
    created({ orderId, totalCents, subtotalCents: 199, discountCents: 500 });

  it("reports an order that costs less than nothing, with how it was priced", () => {
    expect(detect([priced("ord_1", -301)])).toEqual([
      {
        detector: "negative-total",
        details: { orderId: "ord_1", totalCents: -301, subtotalCents: 199, discountCents: 500 },
      },
    ]);
  });

  it("is quiet for an order that costs nothing, and for one that costs something", () => {
    expect(detect([priced("1", 0), priced("2", 1), priced("3", 100_000)])).toEqual([]);
  });

  it("reads a total that is not a number as nothing", () => {
    expect(detect([priced("1", "-5"), priced("2", undefined), priced("3", NaN)])).toEqual([]);
  });

  it("lists findings by order id", () => {
    const found = detect([priced("ord_2", -1), priced("ord_1", -1)]);
    expect(found.map((finding) => finding.details["orderId"])).toEqual(["ord_1", "ord_2"]);
  });
});

describe("detectAll", () => {
  it("gives what every detector finds, in the order of the names", () => {
    const events = [
      event("error.captured", { name: "E", message: "m", path: "/p" }),
      created({ orderId: "1", customerId: "c", idempotencyKey: "k", totalCents: -1 }),
      created({ orderId: "2", customerId: "c", idempotencyKey: "k", totalCents: 5 }),
      reserved("Z", 1),
      listed("c", 1, 10, 1, 2),
    ];
    expect(detectAll(events).map((finding) => finding.detector)).toEqual([
      "crashes-on-request",
      "oversold-stock",
      "pages-miss-orders",
      "duplicate-orders",
      "negative-total",
    ]);
  });
});
