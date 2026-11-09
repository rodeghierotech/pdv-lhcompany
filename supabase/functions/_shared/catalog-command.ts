import { z } from "npm:zod@3.24.1";

const CandidateSchema = z.object({
  externalProductId: z.string().min(1),
  externalVariantId: z.string().min(1),
  name: z.string().trim().min(1).max(180),
  sku: z.string().trim().min(1).max(100),
  salePriceInCents: z.number().int().nonnegative(),
  costInCents: z.number().int().nonnegative(),
  requiresCostReview: z.boolean(),
  tracksInventory: z.boolean(),
  stockQuantity: z.number().int().nonnegative(),
  attributes: z.array(z.object({ name: z.string(), value: z.string() })),
});

export type CatalogCandidate = z.infer<typeof CandidateSchema>;

function moneyToCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Valor monetário inválido da Nuvemshop.");
  return Math.round(parsed * 100);
}

export function toCatalogCandidates(input: {
  products: Array<{
    id: string | number;
    name: string;
    variants: Array<{
      id: string | number;
      sku?: string | null;
      price: string | number;
      cost?: string | number | null;
      stock_management?: boolean;
      stock?: number;
      inventory_levels?: Array<{ location_id: string | number; stock: number }>;
      values?: string[];
    }>;
  }>;
  defaultLocationId: string;
}): CatalogCandidate[] {
  return input.products.flatMap((product) => product.variants.map((variant) => {
    const level = variant.inventory_levels?.find(
      (item) => String(item.location_id) === input.defaultLocationId,
    );
    const hasCost = variant.cost !== null && variant.cost !== undefined && variant.cost !== "";
    return CandidateSchema.parse({
      externalProductId: String(product.id),
      externalVariantId: String(variant.id),
      name: product.name,
      sku: variant.sku ?? "",
      salePriceInCents: moneyToCents(variant.price),
      costInCents: moneyToCents(variant.cost),
      requiresCostReview: !hasCost,
      tracksInventory: variant.stock_management ?? true,
      stockQuantity: level?.stock ?? variant.stock ?? 0,
      attributes: (variant.values ?? []).map((value, index) => ({ name: `Opção ${index + 1}`, value })),
    });
  }));
}
