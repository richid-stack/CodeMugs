import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createShop, type ShopOptions } from "./shop.ts";
import { MemoryTelemetry, type Clock } from "./telemetry.ts";

/** A clock that has moved 5 ms every time it is read, so that times and durations are the same on every run. */
export function steppingClock(startMs = Date.UTC(2026, 0, 15, 9, 0, 0)): Clock {
  let reads = 0;
  return {
    now: () => new Date(startMs + 5 * reads++),
  };
}

export function testShop(options: Partial<ShopOptions> = {}) {
  const clock = options.clock ?? steppingClock();
  const telemetry = new MemoryTelemetry(clock);
  const shop = createShop({ telemetry, clock, ...options });
  return { ...shop, telemetry, clock };
}

/** Starts the shop's server on a free port of this machine and returns a way to call it. */
export async function listening(server: ReturnType<typeof createShop>["server"]) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async (): Promise<void> => {
      server.close();
      await once(server, "close");
    },
  };
}
