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
  minimumStockQuantity: z.number().int().nonnegative().default(3),
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

export const CreateProductCommandSchema = z.object({
  operationId: UuidSchema,
  product: CreateProductInputSchema,
});

export type CreateProductCommand = z.infer<typeof CreateProductCommandSchema>;

export const ProductCatalogQuerySchema = z.object({
  search: z.string().trim().default(""),
  lowStockOnly: z.union([
    z.boolean(),
    z.enum(["true", "false"]).transform((value) => value === "true"),
  ]).default(false),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  limit: z.coerce.number().int().positive().transform((value) => Math.min(value, 100)).default(50),
});

export type ProductCatalogQuery = z.infer<typeof ProductCatalogQuerySchema>;

export const ProductCatalogItemSchema = z.object({
  productId: UuidSchema,
  productName: ProductSchema.shape.name,
  productActive: z.boolean(),
  variantId: UuidSchema,
  sku: ProductVariantSchema.shape.sku,
  barcode: ProductVariantSchema.shape.barcode,
  attributes: ProductVariantSchema.shape.attributes,
  salePriceInCents: MoneyInCentsSchema,
  costInCents: MoneyInCentsSchema,
  quantity: z.number().int(),
  minimumStockQuantity: ProductVariantSchema.shape.minimumStockQuantity,
  tracksInventory: z.boolean(),
  variantActive: z.boolean(),
});

export type ProductCatalogItem = z.infer<typeof ProductCatalogItemSchema>;

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
