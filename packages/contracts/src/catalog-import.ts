import { z } from "zod";

const UuidSchema = z.string().uuid();
const MoneyInCentsSchema = z.number().int().nonnegative();

export const RecordStockReplenishmentInputSchema = z.object({
  variantId: UuidSchema,
  quantity: z.number().int().positive(),
  unitCostInCents: MoneyInCentsSchema,
  sourceReference: z.string().trim().min(1).max(180).optional(),
});

export type RecordStockReplenishmentInput = z.infer<
  typeof RecordStockReplenishmentInputSchema
>;

export const CatalogImportCandidateSchema = z.object({
  externalProductId: z.string().trim().min(1).max(100),
  externalVariantId: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(180),
  sku: z.string().trim().min(1).max(100),
  salePriceInCents: MoneyInCentsSchema,
  costInCents: MoneyInCentsSchema,
  requiresCostReview: z.boolean(),
  tracksInventory: z.boolean(),
  stockQuantity: z.number().int().nonnegative(),
  attributes: z.array(
    z.object({
      name: z.string().trim().min(1).max(80),
      value: z.string().trim().min(1).max(120),
    }),
  ),
});

export type CatalogImportCandidate = z.infer<typeof CatalogImportCandidateSchema>;
