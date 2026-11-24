import type pg from 'pg';
import type {
  CategoryDTO,
  Paginated,
  ProductCreateInput,
  ProductDTO,
  ProductListQuery,
  ProductUpdateInput,
  SellableVariantDTO,
  VariantCreateInput,
  VariantDTO,
  VariantUpdateInput,
} from '@pdv/shared';
import { lockKey, many, maybeOne, one, withTransaction } from '../../db/pool.js';
import type { Db } from '../../db/pool.js';
import { AppError, errors, PG, pgConstraint, pgErrorCode } from '../../shared/errors.js';
import { escapeLike } from '../../shared/validate.js';
import { recordAudit } from '../audit/service.js';

interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  category_id: string | null;
  category_name: string | null;
  active: boolean;
}

interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  barcode: string | null;
  size: string | null;
  color: string | null;
  price_cents: number;
  cost_cents: number;
  min_stock: number;
  active: boolean;
  stock: number;
}

const VARIANT_SELECT = `
  select v.id, v.product_id, v.sku, v.barcode, v.size, v.color, v.price_cents, v.cost_cents,
         v.min_stock, v.active, coalesce(s.quantity, 0)::int as stock
  from product_variants v
  left join stock_levels s on s.variant_id = v.id`;

const variantDTO = (v: VariantRow): VariantDTO => ({
  id: v.id,
  productId: v.product_id,
  sku: v.sku,
  barcode: v.barcode,
  size: v.size,
  color: v.color,
  priceCents: v.price_cents,
  costCents: v.cost_cents,
  minStock: v.min_stock,
  active: v.active,
  stock: v.stock,
});

const productDTO = (p: ProductRow, variants: VariantRow[]): ProductDTO => ({
  id: p.id,
  name: p.name,
  description: p.description,
  categoryId: p.category_id,
  categoryName: p.category_name,
  active: p.active,
  variants: variants.map(variantDTO),
});

/** Traduz violações de unicidade/FK em erros de domínio claros. */
function translateCatalogError(err: unknown): never {
  if (err instanceof AppError) throw err;
  const code = pgErrorCode(err);
  const constraint = pgConstraint(err);
  if (code === PG.uniqueViolation) {
    if (constraint === 'product_variants_sku_uq') {
      throw errors.conflict('SKU_IN_USE', 'Já existe uma variante com este SKU');
    }
    if (constraint === 'product_variants_barcode_uq') {
      throw errors.conflict('BARCODE_IN_USE', 'Já existe uma variante com este código de barras');
    }
    if (constraint === 'categories_name_uq') {
      throw errors.conflict('CATEGORY_EXISTS', 'Já existe uma categoria com este nome');
    }
  }
  if (code === PG.foreignKeyViolation && constraint === 'products_category_id_fkey') {
    throw errors.validation('Categoria inexistente');
  }
  throw err;
}

// ---------- Categorias ----------
export async function listCategories(pool: pg.Pool): Promise<CategoryDTO[]> {
  return many<CategoryDTO>(pool, 'select id, name from categories order by lower(name)');
}

export async function createCategory(
  pool: pg.Pool,
  name: string,
  actorId: string,
): Promise<CategoryDTO> {
  try {
    return await withTransaction(pool, async (tx) => {
      const cat = await one<CategoryDTO>(
        tx,
        'insert into categories (name) values ($1) returning id, name',
        [name],
      );
      await recordAudit(tx, {
        actorId,
        action: 'category.create',
        entity: 'category',
        entityId: cat.id,
        payload: { name },
      });
      return cat;
    });
  } catch (err) {
    return translateCatalogError(err);
  }
}

// ---------- Produtos ----------
async function loadVariants(db: Db, productIds: string[]): Promise<Map<string, VariantRow[]>> {
  const grouped = new Map<string, VariantRow[]>();
  if (productIds.length === 0) return grouped;
  const rows = await many<VariantRow>(
    db,
    `${VARIANT_SELECT} where v.product_id = any($1::uuid[]) order by v.created_at, v.id`,
    [productIds],
  );
  for (const row of rows) {
    const list = grouped.get(row.product_id) ?? [];
    list.push(row);
    grouped.set(row.product_id, list);
  }
  return grouped;
}

const PRODUCT_SELECT = `
  select p.id, p.name, p.description, p.category_id, c.name as category_name, p.active
  from products p
  left join categories c on c.id = p.category_id`;

export async function getProduct(db: Db, id: string): Promise<ProductDTO> {
  const product = await maybeOne<ProductRow>(db, `${PRODUCT_SELECT} where p.id = $1`, [id]);
  if (!product) throw errors.notFound('Produto');
  const variants = await loadVariants(db, [id]);
  return productDTO(product, variants.get(id) ?? []);
}

export async function listProducts(
  pool: pg.Pool,
  query: ProductListQuery,
): Promise<Paginated<ProductDTO>> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (query.q) {
    const like = add(`%${escapeLike(query.q)}%`);
    const exact = add(query.q);
    where.push(
      `(p.name ilike ${like} or exists (
         select 1 from product_variants v
         where v.product_id = p.id and (v.sku ilike ${like} or v.barcode = ${exact})))`,
    );
  }
  if (query.categoryId) where.push(`p.category_id = ${add(query.categoryId)}`);
  if (query.active !== undefined) where.push(`p.active = ${add(query.active)}`);
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';

  const total = Number(
    (await one<{ count: string }>(pool, `select count(*) from products p ${whereSql}`, params))
      .count,
  );

  const limit = add(query.pageSize);
  const offset = add((query.page - 1) * query.pageSize);
  const rows = await many<ProductRow>(
    pool,
    `${PRODUCT_SELECT} ${whereSql} order by lower(p.name), p.id limit ${limit} offset ${offset}`,
    params,
  );
  const variants = await loadVariants(
    pool,
    rows.map((r) => r.id),
  );
  return {
    items: rows.map((r) => productDTO(r, variants.get(r.id) ?? [])),
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}

/** Insere variante; se houver estoque inicial, cria lote + movimentação de entrada. */
async function insertVariant(
  tx: pg.PoolClient,
  productId: string,
  input: VariantCreateInput,
  actorId: string,
): Promise<string> {
  const variant = await one<{ id: string }>(
    tx,
    `insert into product_variants
       (product_id, sku, barcode, size, color, price_cents, cost_cents, min_stock)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      productId,
      input.sku,
      input.barcode ?? null,
      input.size ?? null,
      input.color ?? null,
      input.priceCents,
      input.costCents,
      input.minStock,
    ],
  );
  if (input.initialStock > 0) {
    const batch = await one<{ id: string }>(
      tx,
      `insert into stock_batches (variant_id, quantity, unit_cost_cents, note, created_by)
       values ($1, $2, $3, 'Estoque inicial', $4) returning id`,
      [variant.id, input.initialStock, input.costCents, actorId],
    );
    await tx.query(
      `insert into stock_movements
         (variant_id, type, quantity_delta, reason, batch_id, idempotency_key, actor_id)
       values ($1, 'entrada', $2, 'Estoque inicial', $3, $4, $5)`,
      [variant.id, input.initialStock, batch.id, `variant-init:${variant.id}`, actorId],
    );
  }
  return variant.id;
}

export async function createProduct(
  pool: pg.Pool,
  input: ProductCreateInput,
  actorId: string,
): Promise<{ product: ProductDTO; created: boolean }> {
  try {
    return await withTransaction(pool, async (tx) => {
      // Serializa tentativas concorrentes com a mesma chave de idempotência.
      await lockKey(tx, `product-create:${input.idempotencyKey}`);
      const existing = await maybeOne<{ id: string }>(
        tx,
        'select id from products where idempotency_key = $1',
        [input.idempotencyKey],
      );
      if (existing) return { product: await getProduct(tx, existing.id), created: false };

      const product = await one<{ id: string }>(
        tx,
        `insert into products (name, description, category_id, idempotency_key)
         values ($1, $2, $3, $4) returning id`,
        [input.name, input.description ?? null, input.categoryId ?? null, input.idempotencyKey],
      );
      for (const variant of input.variants) {
        await insertVariant(tx, product.id, variant, actorId);
      }
      await recordAudit(tx, {
        actorId,
        action: 'product.create',
        entity: 'product',
        entityId: product.id,
        payload: { name: input.name, variants: input.variants.map((v) => v.sku) },
      });
      return { product: await getProduct(tx, product.id), created: true };
    });
  } catch (err) {
    return translateCatalogError(err);
  }
}

export async function updateProduct(
  pool: pg.Pool,
  id: string,
  input: ProductUpdateInput,
  actorId: string,
): Promise<ProductDTO> {
  const columns: Record<string, string> = {
    name: 'name',
    description: 'description',
    categoryId: 'category_id',
    active: 'active',
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (key in input) {
      params.push((input as Record<string, unknown>)[key]);
      sets.push(`${column} = $${params.length}`);
    }
  }
  params.push(id);
  try {
    return await withTransaction(pool, async (tx) => {
      const res = await tx.query(
        `update products set ${sets.join(', ')} where id = $${params.length}`,
        params,
      );
      if (res.rowCount === 0) throw errors.notFound('Produto');
      await recordAudit(tx, {
        actorId,
        action: 'product.update',
        entity: 'product',
        entityId: id,
        payload: input as Record<string, unknown>,
      });
      return getProduct(tx, id);
    });
  } catch (err) {
    return translateCatalogError(err);
  }
}

// ---------- Variantes ----------
export async function addVariant(
  pool: pg.Pool,
  productId: string,
  input: VariantCreateInput,
  actorId: string,
): Promise<ProductDTO> {
  try {
    return await withTransaction(pool, async (tx) => {
      const exists = await maybeOne(tx, 'select 1 from products where id = $1 for update', [
        productId,
      ]);
      if (!exists) throw errors.notFound('Produto');
      const variantId = await insertVariant(tx, productId, input, actorId);
      await recordAudit(tx, {
        actorId,
        action: 'variant.create',
        entity: 'variant',
        entityId: variantId,
        payload: { sku: input.sku, productId },
      });
      return getProduct(tx, productId);
    });
  } catch (err) {
    return translateCatalogError(err);
  }
}

export async function updateVariant(
  pool: pg.Pool,
  id: string,
  input: VariantUpdateInput,
  actorId: string,
): Promise<VariantDTO> {
  const columns: Record<string, string> = {
    sku: 'sku',
    barcode: 'barcode',
    size: 'size',
    color: 'color',
    priceCents: 'price_cents',
    costCents: 'cost_cents',
    minStock: 'min_stock',
    active: 'active',
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (key in input) {
      params.push((input as Record<string, unknown>)[key]);
      sets.push(`${column} = $${params.length}`);
    }
  }
  params.push(id);
  try {
    return await withTransaction(pool, async (tx) => {
      const res = await tx.query(
        `update product_variants set ${sets.join(', ')} where id = $${params.length}`,
        params,
      );
      if (res.rowCount === 0) throw errors.notFound('Variante');
      await recordAudit(tx, {
        actorId,
        action: 'variant.update',
        entity: 'variant',
        entityId: id,
        payload: input as Record<string, unknown>,
      });
      const row = await one<VariantRow>(tx, `${VARIANT_SELECT} where v.id = $1`, [id]);
      return variantDTO(row);
    });
  } catch (err) {
    return translateCatalogError(err);
  }
}

// ---------- Busca para o balcão (PDV) ----------
/**
 * Busca variantes vendáveis por código de barras, SKU, nome do produto, tamanho ou cor.
 * Código de barras/SKU exatos vêm primeiro (leitor de código de barras = 1 resultado).
 */
export async function searchSellableVariants(
  pool: pg.Pool,
  q: string,
): Promise<SellableVariantDTO[]> {
  const like = `%${escapeLike(q)}%`;
  const rows = await many<{
    variant_id: string;
    product_id: string;
    product_name: string;
    sku: string;
    barcode: string | null;
    size: string | null;
    color: string | null;
    price_cents: number;
    stock: number;
  }>(
    pool,
    `select v.id as variant_id, p.id as product_id, p.name as product_name, v.sku, v.barcode,
            v.size, v.color, v.price_cents, coalesce(s.quantity, 0)::int as stock
     from product_variants v
     join products p on p.id = v.product_id
     left join stock_levels s on s.variant_id = v.id
     where v.active and p.active
       and (coalesce(v.barcode = $1, false) or lower(v.sku) = lower($1)
            or v.sku ilike $2 or p.name ilike $2
            or (coalesce(v.size, '') || ' ' || coalesce(v.color, '')) ilike $2)
     order by (coalesce(v.barcode = $1, false) or lower(v.sku) = lower($1)) desc,
              lower(p.name), v.sku
     limit 20`,
    [q, like],
  );
  return rows.map((r) => ({
    variantId: r.variant_id,
    productId: r.product_id,
    productName: r.product_name,
    sku: r.sku,
    barcode: r.barcode,
    size: r.size,
    color: r.color,
    priceCents: r.price_cents,
    stock: r.stock,
  }));
}
