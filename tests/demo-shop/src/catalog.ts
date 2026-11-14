import type { Cents } from "./money.ts";

export interface Product {
  readonly sku: string;
  readonly name: string;
  readonly priceCents: Cents;
}

export const PRODUCTS: readonly Product[] = [
  { sku: "MUG-01", name: "Enamel mug", priceCents: 1299 },
  { sku: "TEA-05", name: "Loose leaf tea, 100 g", priceCents: 649 },
  { sku: "POT-02", name: "Cast iron teapot", priceCents: 3450 },
  { sku: "SPN-09", name: "Brass teaspoon", priceCents: 199 },
  { sku: "BOK-03", name: "Pocket field guide", priceCents: 899 },
];

/** How much of each product the shop starts with. */
export const INITIAL_STOCK: Readonly<Record<string, number>> = {
  "MUG-01": 40,
  "TEA-05": 120,
  "POT-02": 12,
  "SPN-09": 300,
  "BOK-03": 25,
};

export function findProduct(sku: string): Product | undefined {
  return PRODUCTS.find((product) => product.sku === sku);
}
