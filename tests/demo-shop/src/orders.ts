import { findProduct } from "./catalog.ts";
import type { Inventory } from "./inventory.ts";
import type { Cents } from "./money.ts";
import { PICKUP_COUNTRY, priceOrder, type PricedLine, type RequestedLine } from "./pricing.ts";
import type { Clock, Telemetry } from "./telemetry.ts";

export interface OrderRequest {
  readonly customerId: string;
  readonly lines: readonly { readonly sku: string; readonly quantity: number }[];
  /** Absent when the order is collected in the shop. */
  readonly address?: { readonly country: string };
  readonly discountCode?: string;
  /** Chosen by the caller, so that sending the same order again does not make a second one. */
  readonly idempotencyKey?: string;
}

export interface Order {
  readonly id: string;
  readonly customerId: string;
  readonly lines: readonly PricedLine[];
  readonly subtotalCents: Cents;
  readonly discountCents: Cents;
  readonly taxCents: Cents;
  readonly totalCents: Cents;
  readonly country: string;
  readonly createdAt: string;
}

export type CreateOrderResult =
  | { readonly ok: true; readonly order: Order; readonly replayed: boolean }
  | {
      readonly ok: false;
      readonly reason:
        "unknown_product" | "unknown_discount_code" | "unsupported_country" | "out_of_stock";
      readonly sku?: string;
    };

export interface OrderServiceOptions {
  readonly inventory: Inventory;
  readonly telemetry: Telemetry;
  readonly clock: Clock;
}

export class OrderService {
  readonly #inventory: Inventory;
  readonly #telemetry: Telemetry;
  readonly #clock: Clock;
  /** Newest first. */
  readonly #orders: Order[] = [];
  readonly #byKey = new Map<string, Promise<CreateOrderResult>>();
  #sequence = 0;

  constructor(options: OrderServiceOptions) {
    this.#inventory = options.inventory;
    this.#telemetry = options.telemetry;
    this.#clock = options.clock;
  }

  /**
   * Makes an order, or says why it cannot. A request that carries a key that was used before, by
   * the same customer, gets the order that the first one made, and no second order is made, even
   * when the two requests are in flight at once.
   */
  createOrder(request: OrderRequest): Promise<CreateOrderResult> {
    if (request.idempotencyKey === undefined) return this.#create(request);

    const key = `${request.customerId}:${request.idempotencyKey}`;
    const earlier = this.#byKey.get(key);
    if (earlier !== undefined) {
      return earlier.then((result) => (result.ok ? { ...result, replayed: true } : result));
    }

    const attempt = this.#create(request);
    this.#byKey.set(key, attempt);
    // A request that failed did not make an order, so the same key may try again.
    const forget = (): void => {
      this.#byKey.delete(key);
    };
    attempt.then((result) => {
      if (!result.ok) forget();
    }, forget);
    return attempt;
  }

  /** A customer's orders, newest first, in pages of `pageSize` that start at page 1. */
  listOrders(customerId: string, page: number, pageSize: number): Order[] {
    const own = this.#orders.filter((order) => order.customerId === customerId);
    const start = (page - 1) * pageSize;
    return own.slice(start, start + pageSize);
  }

  countOrders(customerId: string): number {
    return this.#orders.filter((order) => order.customerId === customerId).length;
  }

  async #create(request: OrderRequest): Promise<CreateOrderResult> {
    const requested: RequestedLine[] = [];
    for (const line of request.lines) {
      const product = findProduct(line.sku);
      if (product === undefined) return this.#reject("unknown_product", line.sku);
      requested.push({ product, quantity: line.quantity });
    }

    const country = request.address?.country ?? PICKUP_COUNTRY;
    const priced = priceOrder(requested, request.discountCode, country);
    if (!priced.ok) return this.#reject(priced.reason);

    const taken: RequestedLine[] = [];
    for (const line of requested) {
      if (!(await this.#inventory.reserve(line.product.sku, line.quantity))) {
        // Give back what this order already took, so that a half-made order holds nothing.
        for (const back of taken) await this.#inventory.release(back.product.sku, back.quantity);
        return this.#reject("out_of_stock", line.product.sku);
      }
      taken.push(line);
      this.#telemetry.emit("inventory.reserved", {
        sku: line.product.sku,
        quantity: line.quantity,
      });
    }

    this.#sequence += 1;
    const order: Order = {
      id: `ord_${String(this.#sequence).padStart(6, "0")}`,
      customerId: request.customerId,
      lines: priced.totals.lines,
      subtotalCents: priced.totals.subtotalCents,
      discountCents: priced.totals.discountCents,
      taxCents: priced.totals.taxCents,
      totalCents: priced.totals.totalCents,
      country,
      createdAt: this.#clock.now().toISOString(),
    };
    this.#orders.unshift(order);
    this.#telemetry.emit("order.created", {
      orderId: order.id,
      customerId: order.customerId,
      idempotencyKey: request.idempotencyKey ?? null,
      lineCount: order.lines.length,
      subtotalCents: order.subtotalCents,
      discountCents: order.discountCents,
      taxCents: order.taxCents,
      totalCents: order.totalCents,
      country: order.country,
    });
    return { ok: true, order, replayed: false };
  }

  #reject(
    reason: Extract<CreateOrderResult, { ok: false }>["reason"],
    sku?: string,
  ): CreateOrderResult {
    this.#telemetry.emit("order.rejected", { reason, sku: sku ?? null });
    return sku === undefined ? { ok: false, reason } : { ok: false, reason, sku };
  }
}
