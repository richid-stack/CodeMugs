import type { Product } from "./catalog.ts";
import { basisPointsOf, type Cents } from "./money.ts";

/** Tax rates in basis points, by the country an order is sent to. */
const TAX_BASIS_POINTS: Readonly<Record<string, number>> = {
  GB: 2000,
  DE: 1900,
  FR: 2000,
  US: 0,
};

/** An order that is collected in the shop has no address, and is taxed as the shop's own country. */
export const PICKUP_COUNTRY = "GB";

type Discount =
  | { readonly kind: "flat"; readonly cents: Cents }
  | { readonly kind: "percent"; readonly basisPoints: number };

const DISCOUNTS: Readonly<Record<string, Discount>> = {
  WELCOME5: { kind: "flat", cents: 500 },
  SPRING10: { kind: "percent", basisPoints: 1000 },
};

export interface RequestedLine {
  readonly product: Product;
  readonly quantity: number;
}

export interface PricedLine {
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitCents: Cents;
  readonly lineCents: Cents;
}

export interface Totals {
  readonly lines: readonly PricedLine[];
  readonly subtotalCents: Cents;
  readonly discountCents: Cents;
  readonly taxCents: Cents;
  readonly totalCents: Cents;
}

export type PricingResult =
  | { readonly ok: true; readonly totals: Totals }
  | { readonly ok: false; readonly reason: "unknown_discount_code" | "unsupported_country" };

/**
 * What an order costs. The discount comes off the subtotal and can never be more than it, and the
 * tax is worked out once, on what is left, and rounded half up. The total is never negative.
 */
export function priceOrder(
  requested: readonly RequestedLine[],
  discountCode: string | undefined,
  country: string,
): PricingResult {
  const taxBasisPoints = TAX_BASIS_POINTS[country];
  if (taxBasisPoints === undefined) return { ok: false, reason: "unsupported_country" };

  const lines = requested.map(({ product, quantity }) => ({
    sku: product.sku,
    name: product.name,
    quantity,
    unitCents: product.priceCents,
    lineCents: product.priceCents * quantity,
  }));
  const subtotalCents = lines.reduce((sum, line) => sum + line.lineCents, 0);

  let discountCents = 0;
  if (discountCode !== undefined) {
    const discount = DISCOUNTS[discountCode];
    if (discount === undefined) return { ok: false, reason: "unknown_discount_code" };
    discountCents =
      discount.kind === "flat"
        ? Math.min(discount.cents, subtotalCents)
        : basisPointsOf(subtotalCents, discount.basisPoints);
  }

  const taxableCents = subtotalCents - discountCents;
  const taxCents = basisPointsOf(taxableCents, taxBasisPoints);
  return {
    ok: true,
    totals: {
      lines,
      subtotalCents,
      discountCents,
      taxCents,
      totalCents: taxableCents + taxCents,
    },
  };
}
