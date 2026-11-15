import {
  ProductCatalogItemSchema,
  ProductSchema,
  type Product,
  type ProductCatalogItem,
  type ProductCatalogQuery,
} from "@lh-company/contracts";
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

interface CatalogRow extends VariantRow {
  product_name: string;
  product_active: boolean;
  quantity: number;
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
  list(client: PoolClient, query: ProductCatalogQuery): Promise<ProductCatalogItem[]>;
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
    async list(client, query) {
      // The explicit escape character makes user %, _ and ! literal text.
      const searchPattern = `%${query.search.replace(/[!%_]/g, "!$&")}%`;
      const result = await client.query<CatalogRow>(`
        SELECT variant.id, variant.product_id, product.name AS product_name,
               product.active AS product_active, variant.sku, variant.barcode,
               variant.attributes, variant.sale_price_in_cents, variant.cost_in_cents,
               variant.tracks_inventory, variant.minimum_stock_quantity, variant.active,
               COALESCE(balance.quantity, 0) AS quantity
        FROM product_variant AS variant
        JOIN product ON product.id = variant.product_id
        LEFT JOIN inventory_balance AS balance ON balance.variant_id = variant.id
        WHERE ($1 = '' OR product.name ILIKE $2 ESCAPE '!'
               OR variant.sku ILIKE $2 ESCAPE '!' OR variant.barcode ILIKE $2 ESCAPE '!')
          AND ($3 = 'all' OR ($3 = 'active' AND product.active AND variant.active)
               OR ($3 = 'inactive' AND (NOT product.active OR NOT variant.active)))
          AND (NOT $4::BOOLEAN OR (variant.tracks_inventory
               AND COALESCE(balance.quantity, 0) <= variant.minimum_stock_quantity))
        ORDER BY product.name, variant.sku, variant.id
        LIMIT $5
      `, [query.search, searchPattern, query.status, query.lowStockOnly, query.limit]);
      return result.rows.map((row) => ProductCatalogItemSchema.parse({
        productId: row.product_id,
        productName: row.product_name,
        productActive: row.product_active,
        variantId: row.id,
        sku: row.sku,
        barcode: row.barcode,
        attributes: row.attributes,
        salePriceInCents: row.sale_price_in_cents,
        costInCents: row.cost_in_cents,
        quantity: row.quantity,
        minimumStockQuantity: row.minimum_stock_quantity,
        tracksInventory: row.tracks_inventory,
        variantActive: row.active,
      }));
    },
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
