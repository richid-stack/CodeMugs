import { INITIAL_STOCK } from "./catalog.ts";
import { Inventory, MemoryStockStore, type StockStore } from "./inventory.ts";
import { OrderService } from "./orders.ts";
import { createShopServer } from "./server.ts";
import { systemClock, type Clock, type Telemetry } from "./telemetry.ts";

export interface ShopOptions {
  readonly telemetry: Telemetry;
  readonly clock?: Clock;
  /** Starting stock by sku. The catalogue's own levels when left out. */
  readonly stock?: Readonly<Record<string, number>>;
  readonly store?: StockStore;
}

/** Puts the shop together. Tests and the harness that drives it start it the same way `main` does. */
export function createShop(options: ShopOptions) {
  const clock = options.clock ?? systemClock;
  const stock = options.stock ?? INITIAL_STOCK;
  const inventory = new Inventory(options.store ?? new MemoryStockStore(stock));
  for (const [sku, quantity] of Object.entries(stock)) {
    options.telemetry.emit("inventory.stocked", { sku, quantity });
  }
  const orders = new OrderService({ inventory, telemetry: options.telemetry, clock });
  const server = createShopServer({ orders, telemetry: options.telemetry, clock });
  return { inventory, orders, server };
}
