import { z } from "zod";
import { InventoryMovementSchema, ProductCatalogItemSchema } from "./products.js";

export const CreateReplenishmentCommandSchema = z.strictObject({
  operationId: z.string().uuid(),
  variantId: z.string().uuid(),
  quantity: z.number().int().positive(),
  unitCostInCents: z.number().int().nonnegative(),
  sourceReference: z.string().trim().max(200).optional(),
});

export type CreateReplenishmentCommand = z.infer<typeof CreateReplenishmentCommandSchema>;

export const InventoryHistoryItemSchema = InventoryMovementSchema.extend({
  lotId: z.string().uuid().nullable(),
  operationId: z.string().uuid().nullable(),
  sourceReference: z.string().nullable(),
});

export type InventoryHistoryItem = z.infer<typeof InventoryHistoryItemSchema>;

export const InventoryHistoryResponseSchema = ProductCatalogItemSchema.pick({
  variantId: true,
  productId: true,
  productName: true,
  sku: true,
  attributes: true,
  quantity: true,
  costInCents: true,
}).extend({
  estimatedStockCostInCents: z.number().int(),
  movements: z.array(InventoryHistoryItemSchema),
});

export type InventoryHistoryResponse = z.infer<typeof InventoryHistoryResponseSchema>;
