import { ProductSchema, type Product } from "@lh-company/contracts";
import type { PoolClient } from "pg";

import { ProductNotFoundError } from "./product-errors.js";

interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  active: boolean;
}

interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  barcode: string | null;
  attributes: unknown;
  sale_price_in_cents: number;
  cost_in_cents: number;
  tracks_inventory: boolean;
  minimum_stock_quantity: number;
  active: boolean;
}

export interface ProductOperation {
  product: Product;
  fingerprint: string | null;
}

export interface ProductInsertion {
  product: Product;
  operationId: string;
  fingerprint: string;
}

export interface ProductRepository {
  findById(client: PoolClient, productId: string): Promise<Product | undefined>;
  findByOperationId(client: PoolClient, operationId: string): Promise<ProductOperation | undefined>;
  insert(client: PoolClient, insertion: ProductInsertion): Promise<Product>;
}

export function createProductRepository(): ProductRepository {
  async function findById(client: PoolClient, productId: string): Promise<Product | undefined> {
    const result = await client.query<ProductRow>(
      "SELECT id, name, description, category, active FROM product WHERE id = $1", [productId],
    );
    const product = result.rows[0];
    if (!product) {
      return undefined;
    }
    const variants = await client.query<VariantRow>(`
      SELECT id, product_id, sku, barcode, attributes, sale_price_in_cents,
             cost_in_cents, tracks_inventory, minimum_stock_quantity, active
      FROM product_variant WHERE product_id = $1 ORDER BY sku, id
    `, [productId]);
    return ProductSchema.parse({
      ...product,
      variants: variants.rows.map((variant) => ({
        id: variant.id,
        productId: variant.product_id,
        sku: variant.sku,
        barcode: variant.barcode,
        attributes: variant.attributes,
        salePriceInCents: variant.sale_price_in_cents,
        costInCents: variant.cost_in_cents,
        tracksInventory: variant.tracks_inventory,
        minimumStockQuantity: variant.minimum_stock_quantity,
        active: variant.active,
      })),
    });
  }

  return {
    findById,
    async findByOperationId(client, operationId) {
      const result = await client.query<{ id: string; operation_fingerprint: string | null }>(
        "SELECT id, operation_fingerprint FROM product WHERE operation_id = $1", [operationId],
      );
      const operation = result.rows[0];
      if (!operation) {
        return undefined;
      }
      const product = await findById(client, operation.id);
      if (!product) {
        throw new ProductNotFoundError();
      }
      return { product, fingerprint: operation.operation_fingerprint };
    },
    async insert(client, { product, operationId, fingerprint }) {
      await client.query(`
        INSERT INTO product (id, name, description, category, active, operation_id, operation_fingerprint)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [product.id, product.name, product.description, product.category, product.active, operationId, fingerprint]);
      for (const variant of product.variants) {
        await client.query(`
          INSERT INTO product_variant (
            id, product_id, sku, barcode, attributes, sale_price_in_cents,
            cost_in_cents, tracks_inventory, minimum_stock_quantity, active
          ) VALUES ($1, $2, $3, $4, $5::JSONB, $6, $7, $8, $9, $10)
        `, [
          variant.id, product.id, variant.sku, variant.barcode, JSON.stringify(variant.attributes),
          variant.salePriceInCents, variant.costInCents, variant.tracksInventory,
          variant.minimumStockQuantity, variant.active,
        ]);
        if (variant.tracksInventory) {
          await client.query("INSERT INTO inventory_balance (variant_id, quantity) VALUES ($1, 0)", [variant.id]);
        }
      }
      const created = await findById(client, product.id);
      if (!created) {
        throw new ProductNotFoundError();
      }
      return created;
    },
  };
}
