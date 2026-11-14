import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PRODUCTS } from "./catalog.ts";
import { formatCents } from "./money.ts";
import type { Order, OrderService } from "./orders.ts";
import { parseOrderRequest } from "./requests.ts";
import type { Clock, Telemetry } from "./telemetry.ts";

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

export interface ShopServerOptions {
  readonly orders: OrderService;
  readonly telemetry: Telemetry;
  readonly clock: Clock;
}

class BodyTooLarge extends Error {}
class BadJson extends Error {}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new BadJson();
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function describeOrder(order: Order): Record<string, unknown> {
  return {
    id: order.id,
    createdAt: order.createdAt,
    lines: order.lines,
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    taxCents: order.taxCents,
    totalCents: order.totalCents,
    total: formatCents(order.totalCents),
  };
}

function positiveInteger(text: string | null, fallback: number, max: number): number | undefined {
  if (text === null) return fallback;
  if (!/^[0-9]{1,9}$/.test(text)) return undefined;
  const value = Number(text);
  return value >= 1 && value <= max ? value : undefined;
}

type Handled = { readonly route: string; readonly status: number };

export function createShopServer(options: ShopServerOptions): Server {
  const { orders, telemetry, clock } = options;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<Handled> {
    const url = new URL(request.url ?? "/", "http://shop.invalid");
    const method = request.method ?? "GET";
    const reply = (route: string, status: number, body: unknown): Handled => {
      send(response, status, body);
      return { route, status };
    };

    if (method === "GET" && url.pathname === "/health")
      return reply("GET /health", 200, { ok: true });

    if (method === "GET" && url.pathname === "/products") {
      return reply("GET /products", 200, {
        products: PRODUCTS.map((product) => ({
          ...product,
          price: formatCents(product.priceCents),
        })),
      });
    }

    if (method === "POST" && url.pathname === "/orders") {
      const route = "POST /orders";
      let body: unknown;
      try {
        body = await readJson(request);
      } catch (error) {
        if (error instanceof BodyTooLarge) return reply(route, 413, { error: "body_too_large" });
        if (error instanceof BadJson) return reply(route, 400, { error: "invalid_json" });
        throw error;
      }
      const key = request.headers["idempotency-key"];
      const parsed = parseOrderRequest(body, typeof key === "string" ? key : undefined);
      if (!parsed.ok) return reply(route, 400, { error: "invalid_request", field: parsed.field });

      const result = await orders.createOrder(parsed.request);
      if (!result.ok) {
        const status = result.reason === "out_of_stock" ? 409 : 422;
        return reply(route, status, {
          error: result.reason,
          ...(result.sku === undefined ? {} : { sku: result.sku }),
        });
      }
      return reply(route, result.replayed ? 200 : 201, {
        order: describeOrder(result.order),
        replayed: result.replayed,
      });
    }

    const listing = /^\/customers\/([A-Za-z0-9_-]{1,64})\/orders$/.exec(url.pathname);
    if (method === "GET" && listing?.[1] !== undefined) {
      const route = "GET /customers/:id/orders";
      const page = positiveInteger(url.searchParams.get("page"), 1, 1_000_000);
      const pageSize = positiveInteger(
        url.searchParams.get("pageSize"),
        DEFAULT_PAGE_SIZE,
        MAX_PAGE_SIZE,
      );
      if (page === undefined) return reply(route, 400, { error: "invalid_request", field: "page" });
      if (pageSize === undefined) {
        return reply(route, 400, { error: "invalid_request", field: "pageSize" });
      }
      const customerId = listing[1];
      const listed = orders.listOrders(customerId, page, pageSize);
      const total = orders.countOrders(customerId);
      telemetry.emit("orders.listed", {
        customerId,
        page,
        pageSize,
        returned: listed.length,
        total,
      });
      return reply(route, 200, { orders: listed.map(describeOrder), page, pageSize, total });
    }

    return reply("unmatched", 404, { error: "not_found" });
  }

  return createServer((request, response) => {
    const started = clock.now().getTime();
    handle(request, response).then(
      ({ route, status }) => {
        telemetry.emit("http.request", {
          route,
          status,
          durationMs: clock.now().getTime() - started,
        });
      },
      (error: unknown) => {
        // The caller is told nothing of what went wrong. The details go to the shop's own telemetry.
        telemetry.emit("error.captured", {
          name: error instanceof Error ? error.name : "NonError",
          message:
            error instanceof Error ? error.message : "a value that is not an error was thrown",
          method: request.method ?? "GET",
          path: new URL(request.url ?? "/", "http://shop.invalid").pathname,
        });
        telemetry.emit("http.request", {
          route: "error",
          status: 500,
          durationMs: clock.now().getTime() - started,
        });
        if (!response.headersSent) send(response, 500, { error: "internal_error" });
        else response.end();
      },
    );
  });
}
