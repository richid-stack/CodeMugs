import type { OrderRequest } from "./orders.ts";

export type ParsedOrderRequest =
  | { readonly ok: true; readonly request: OrderRequest }
  /** `field` names where the problem is, never what was sent. */
  | { readonly ok: false; readonly field: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const COUNTRY = /^[A-Z]{2}$/;
const SKU = /^[A-Z0-9-]{1,32}$/;
const MAX_LINES = 50;
const MAX_QUANTITY = 99;
const MAX_KEY_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Turns what came over the wire into an order request, or says which field is wrong. */
export function parseOrderRequest(body: unknown, idempotencyKey?: string): ParsedOrderRequest {
  if (!isRecord(body)) return { ok: false, field: "body" };

  const { customerId, lines, address, discountCode } = body;
  if (typeof customerId !== "string" || !ID.test(customerId)) {
    return { ok: false, field: "customerId" };
  }

  if (!Array.isArray(lines) || lines.length < 1 || lines.length > MAX_LINES) {
    return { ok: false, field: "lines" };
  }
  const parsedLines: { sku: string; quantity: number }[] = [];
  for (const line of lines as unknown[]) {
    if (!isRecord(line)) return { ok: false, field: "lines" };
    const { sku, quantity } = line;
    if (typeof sku !== "string" || !SKU.test(sku)) return { ok: false, field: "lines.sku" };
    if (
      typeof quantity !== "number" ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_QUANTITY
    ) {
      return { ok: false, field: "lines.quantity" };
    }
    parsedLines.push({ sku, quantity });
  }

  let parsedAddress: { country: string } | undefined;
  if (address !== undefined) {
    if (!isRecord(address)) return { ok: false, field: "address" };
    const { country } = address;
    if (typeof country !== "string" || !COUNTRY.test(country)) {
      return { ok: false, field: "address.country" };
    }
    parsedAddress = { country };
  }

  if (
    discountCode !== undefined &&
    (typeof discountCode !== "string" || discountCode.length > 32)
  ) {
    return { ok: false, field: "discountCode" };
  }
  if (
    idempotencyKey !== undefined &&
    (idempotencyKey === "" || idempotencyKey.length > MAX_KEY_LENGTH)
  ) {
    return { ok: false, field: "Idempotency-Key" };
  }

  return {
    ok: true,
    request: {
      customerId,
      lines: parsedLines,
      ...(parsedAddress === undefined ? {} : { address: parsedAddress }),
      ...(discountCode === undefined ? {} : { discountCode }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
  };
}
