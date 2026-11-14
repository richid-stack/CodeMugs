/**
 * Where the stock levels live. It is a separate thing, and asynchronous, because in a real shop it
 * is a database or a cache, and every call to it is a point where other requests get to run.
 */
export interface StockStore {
  get(sku: string): Promise<number>;
  set(sku: string, quantity: number): Promise<void>;
  /** Takes `quantity` if there are that many, as one step, and says whether it did. */
  takeIfAvailable(sku: string, quantity: number): Promise<boolean>;
  /** Adds `quantity`, as one step. */
  add(sku: string, quantity: number): Promise<void>;
}

export class MemoryStockStore implements StockStore {
  readonly #stock = new Map<string, number>();

  constructor(initial: Readonly<Record<string, number>>) {
    for (const [sku, quantity] of Object.entries(initial)) this.#stock.set(sku, quantity);
  }

  async get(sku: string): Promise<number> {
    await Promise.resolve();
    return this.#stock.get(sku) ?? 0;
  }

  async set(sku: string, quantity: number): Promise<void> {
    await Promise.resolve();
    this.#stock.set(sku, quantity);
  }

  async add(sku: string, quantity: number): Promise<void> {
    this.#stock.set(sku, (this.#stock.get(sku) ?? 0) + quantity);
    await Promise.resolve();
  }

  async takeIfAvailable(sku: string, quantity: number): Promise<boolean> {
    // No await between the check and the change: nothing else runs in between.
    const have = this.#stock.get(sku) ?? 0;
    if (have < quantity) return false;
    this.#stock.set(sku, have - quantity);
    await Promise.resolve();
    return true;
  }
}

export class Inventory {
  readonly #store: StockStore;

  constructor(store: StockStore) {
    this.#store = store;
  }

  available(sku: string): Promise<number> {
    return this.#store.get(sku);
  }

  /** Takes the units for an order if all of them are there. It never takes some of them. */
  reserve(sku: string, quantity: number): Promise<boolean> {
    return this.#store.takeIfAvailable(sku, quantity);
  }

  /** Puts units back, when an order that took them did not go through. */
  release(sku: string, quantity: number): Promise<void> {
    return this.#store.add(sku, quantity);
  }
}
