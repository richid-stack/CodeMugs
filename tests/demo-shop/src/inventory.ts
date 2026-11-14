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
  readonly #latencyMs: number;

  /**
   * `latencyMs` is how long each call takes to come back, as a call to a database does. A call
   * does what it does at once and then waits that long, so calls that overlap in time overlap in
   * what they see. With none, it only gives other work a turn.
   */
  constructor(initial: Readonly<Record<string, number>>, latencyMs = 0) {
    for (const [sku, quantity] of Object.entries(initial)) this.#stock.set(sku, quantity);
    this.#latencyMs = latencyMs;
  }

  #reply(): Promise<void> {
    return this.#latencyMs > 0
      ? new Promise((resolve) => setTimeout(resolve, this.#latencyMs))
      : Promise.resolve();
  }

  async get(sku: string): Promise<number> {
    const quantity = this.#stock.get(sku) ?? 0;
    await this.#reply();
    return quantity;
  }

  async set(sku: string, quantity: number): Promise<void> {
    this.#stock.set(sku, quantity);
    await this.#reply();
  }

  async add(sku: string, quantity: number): Promise<void> {
    this.#stock.set(sku, (this.#stock.get(sku) ?? 0) + quantity);
    await this.#reply();
  }

  async takeIfAvailable(sku: string, quantity: number): Promise<boolean> {
    // The check and the change are one step: nothing else runs in between.
    const have = this.#stock.get(sku) ?? 0;
    const taken = have >= quantity;
    if (taken) this.#stock.set(sku, have - quantity);
    await this.#reply();
    return taken;
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
