import { z } from "zod";

const UuidSchema = z.string().uuid();
const MoneyInCentsSchema = z.number().int().nonnegative();

export const ProductVariantAttributeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(120),
});

export const ProductVariantSchema = z.object({
  id: UuidSchema,
  productId: UuidSchema,
  sku: z.string().trim().min(1).max(100),
  barcode: z.string().trim().min(1).max(100).nullable(),
  attributes: z.array(ProductVariantAttributeSchema),
  salePriceInCents: MoneyInCentsSchema,
  costInCents: MoneyInCentsSchema,
  tracksInventory: z.boolean(),
  active: z.boolean(),
});

export type ProductVariant = z.infer<typeof ProductVariantSchema>;

export const ProductSchema = z.object({
  id: UuidSchema,
  name: z.string().trim().min(1).max(180),
  description: z.string().trim().max(4_000).nullable(),
  category: z.string().trim().min(1).max(120).nullable(),
  active: z.boolean(),
  variants: z.array(ProductVariantSchema).min(1),
});

export type Product = z.infer<typeof ProductSchema>;

export const CreateProductInputSchema = ProductSchema.omit({ id: true }).extend({
  variants: z
    .array(ProductVariantSchema.omit({ id: true, productId: true }))
    .min(1),
});

export type CreateProductInput = z.infer<typeof CreateProductInputSchema>;

export const InventoryMovementReasonSchema = z.enum([
  "replenishment",
  "adjustment",
  "physical_sale",
  "sale_cancellation",
  "online_order",
  "online_order_cancellation",
  "return_received",
]);

export type InventoryMovementReason = z.infer<
  typeof InventoryMovementReasonSchema
>;

export const InventoryMovementSchema = z.object({
  id: UuidSchema,
  variantId: UuidSchema,
  reason: InventoryMovementReasonSchema,
  quantityDelta: z.number().int().refine((value) => value !== 0, {
    message: "Movimento de estoque deve alterar a quantidade.",
  }),
  occurredAt: z.string().datetime({ offset: true }),
  referenceId: UuidSchema.nullable(),
});

export type InventoryMovement = z.infer<typeof InventoryMovementSchema>;
