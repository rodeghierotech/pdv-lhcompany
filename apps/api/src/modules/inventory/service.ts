import type pg from 'pg';
import type {
  MovementListQuery,
  MovementType,
  Paginated,
  StockAdjustInput,
  StockEntryInput,
  StockMovementDTO,
  VariantDTO,
} from '@pdv/shared';
import { lockKey, many, maybeOne, one, withTransaction } from '../../db/pool.js';
import { AppError, errors, PG, pgErrorCode } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';

interface MovementRow {
  id: string;
  variant_id: string;
  sku: string;
  type: MovementType;
  quantity_delta: number;
  reason: string | null;
  reverses_movement_id: string | null;
  created_at: Date;
  actor_name: string | null;
}

const MOVEMENT_SELECT = `
  select m.id, m.variant_id, v.sku, m.type, m.quantity_delta, m.reason,
         m.reverses_movement_id, m.created_at, u.name as actor_name
  from stock_movements m
  join product_variants v on v.id = m.variant_id
  left join users u on u.id = m.actor_id`;

const movementDTO = (m: MovementRow): StockMovementDTO => ({
  id: m.id,
  variantId: m.variant_id,
  sku: m.sku,
  type: m.type,
  quantityDelta: m.quantity_delta,
  reason: m.reason,
  reversesMovementId: m.reverses_movement_id,
  createdAt: m.created_at.toISOString(),
  actorName: m.actor_name,
});

export interface MovementResult {
  movement: StockMovementDTO;
  stock: number;
  /** false quando a mesma chave de idempotência já havia sido processada. */
  created: boolean;
}

async function getMovement(db: pg.Pool | pg.PoolClient, id: string): Promise<StockMovementDTO> {
  return movementDTO(await one<MovementRow>(db, `${MOVEMENT_SELECT} where m.id = $1`, [id]));
}

async function currentStock(tx: pg.PoolClient, variantId: string): Promise<number> {
  const row = await maybeOne<{ quantity: number }>(
    tx,
    'select quantity from stock_levels where variant_id = $1',
    [variantId],
  );
  return row?.quantity ?? 0;
}

/** Bloqueia o saldo da variante (serializa movimentações concorrentes) e devolve o valor atual. */
async function lockStock(tx: pg.PoolClient, variantId: string): Promise<number> {
  const row = await maybeOne<{ quantity: number }>(
    tx,
    'select quantity from stock_levels where variant_id = $1 for update',
    [variantId],
  );
  if (!row) throw errors.notFound('Variante');
  return row.quantity;
}

interface ExistingMovement {
  id: string;
  variant_id: string;
  type: MovementType;
  quantity_delta: number;
  reverses_movement_id: string | null;
}

async function findByKey(tx: pg.PoolClient, key: string): Promise<ExistingMovement | null> {
  return maybeOne<ExistingMovement>(
    tx,
    `select id, variant_id, type, quantity_delta, reverses_movement_id
     from stock_movements where idempotency_key = $1`,
    [key],
  );
}

async function replay(
  tx: pg.PoolClient,
  existing: ExistingMovement,
  matches: boolean,
): Promise<MovementResult> {
  if (!matches) {
    throw errors.conflict(
      'IDEMPOTENCY_KEY_REUSED',
      'Esta chave de idempotência já foi usada com dados diferentes',
    );
  }
  return {
    movement: await getMovement(tx, existing.id),
    stock: await currentStock(tx, existing.variant_id),
    created: false,
  };
}

function translateStockError(err: unknown): never {
  if (err instanceof AppError) throw err;
  const code = pgErrorCode(err);
  if (code === PG.foreignKeyViolation) throw errors.notFound('Variante');
  if (code === PG.uniqueViolation) {
    throw errors.conflict('DUPLICATE_OPERATION', 'Operação já registrada');
  }
  throw err;
}

export async function registerEntry(
  pool: pg.Pool,
  input: StockEntryInput,
  actorId: string,
): Promise<MovementResult> {
  try {
    return await withTransaction(pool, async (tx) => {
      await lockKey(tx, `stock:${input.idempotencyKey}`);
      const existing = await findByKey(tx, input.idempotencyKey);
      if (existing) {
        return replay(
          tx,
          existing,
          existing.type === 'entrada' &&
            existing.variant_id === input.variantId &&
            existing.quantity_delta === input.quantity,
        );
      }
      await lockStock(tx, input.variantId);
      const variant = await one<{ cost_cents: number }>(
        tx,
        'select cost_cents from product_variants where id = $1',
        [input.variantId],
      );
      const batch = await one<{ id: string }>(
        tx,
        `insert into stock_batches (variant_id, quantity, unit_cost_cents, note, created_by)
         values ($1, $2, $3, $4, $5) returning id`,
        [
          input.variantId,
          input.quantity,
          input.unitCostCents ?? variant.cost_cents,
          input.note ?? null,
          actorId,
        ],
      );
      const movement = await one<{ id: string }>(
        tx,
        `insert into stock_movements
           (variant_id, type, quantity_delta, reason, batch_id, idempotency_key, actor_id)
         values ($1, 'entrada', $2, $3, $4, $5, $6) returning id`,
        [
          input.variantId,
          input.quantity,
          input.note ?? null,
          batch.id,
          input.idempotencyKey,
          actorId,
        ],
      );
      await recordAudit(tx, {
        actorId,
        action: 'stock.entry',
        entity: 'stock_movement',
        entityId: movement.id,
        payload: { variantId: input.variantId, quantity: input.quantity },
      });
      return {
        movement: await getMovement(tx, movement.id),
        stock: await currentStock(tx, input.variantId),
        created: true,
      };
    });
  } catch (err) {
    return translateStockError(err);
  }
}

export async function registerAdjustment(
  pool: pg.Pool,
  input: StockAdjustInput,
  actorId: string,
): Promise<MovementResult> {
  try {
    return await withTransaction(pool, async (tx) => {
      await lockKey(tx, `stock:${input.idempotencyKey}`);
      const existing = await findByKey(tx, input.idempotencyKey);
      if (existing) {
        return replay(
          tx,
          existing,
          existing.type === 'ajuste' &&
            existing.variant_id === input.variantId &&
            existing.quantity_delta === input.delta,
        );
      }
      const balance = await lockStock(tx, input.variantId);
      if (balance + input.delta < 0) {
        throw errors.unprocessable(
          'INSUFFICIENT_STOCK',
          `Ajuste deixaria o estoque negativo (saldo atual: ${balance})`,
        );
      }
      const movement = await one<{ id: string }>(
        tx,
        `insert into stock_movements
           (variant_id, type, quantity_delta, reason, idempotency_key, actor_id)
         values ($1, 'ajuste', $2, $3, $4, $5) returning id`,
        [input.variantId, input.delta, input.reason, input.idempotencyKey, actorId],
      );
      await recordAudit(tx, {
        actorId,
        action: 'stock.adjust',
        entity: 'stock_movement',
        entityId: movement.id,
        payload: { variantId: input.variantId, delta: input.delta, reason: input.reason },
      });
      return {
        movement: await getMovement(tx, movement.id),
        stock: await currentStock(tx, input.variantId),
        created: true,
      };
    });
  } catch (err) {
    return translateStockError(err);
  }
}

/** Estorna uma entrada ou ajuste manual com uma movimentação compensatória (nunca apaga). */
export async function reverseMovement(
  pool: pg.Pool,
  movementId: string,
  input: { reason: string; idempotencyKey: string },
  actorId: string,
): Promise<MovementResult> {
  try {
    return await withTransaction(pool, async (tx) => {
      await lockKey(tx, `stock:${input.idempotencyKey}`);
      const existing = await findByKey(tx, input.idempotencyKey);
      if (existing) {
        return replay(
          tx,
          existing,
          existing.type === 'estorno' && existing.reverses_movement_id === movementId,
        );
      }
      const original = await maybeOne<{
        id: string;
        variant_id: string;
        type: MovementType;
        quantity_delta: number;
      }>(tx, 'select id, variant_id, type, quantity_delta from stock_movements where id = $1', [
        movementId,
      ]);
      if (!original) throw errors.notFound('Movimentação');
      if (original.type !== 'entrada' && original.type !== 'ajuste') {
        throw errors.unprocessable(
          'NOT_REVERSIBLE',
          'Apenas entradas e ajustes manuais podem ser estornados aqui',
        );
      }
      const alreadyReversed = await maybeOne(
        tx,
        'select 1 from stock_movements where reverses_movement_id = $1',
        [movementId],
      );
      if (alreadyReversed) {
        throw errors.conflict('ALREADY_REVERSED', 'Esta movimentação já foi estornada');
      }
      const balance = await lockStock(tx, original.variant_id);
      const delta = -original.quantity_delta;
      if (balance + delta < 0) {
        throw errors.unprocessable(
          'INSUFFICIENT_STOCK',
          `Estorno deixaria o estoque negativo (saldo atual: ${balance})`,
        );
      }
      const movement = await one<{ id: string }>(
        tx,
        `insert into stock_movements
           (variant_id, type, quantity_delta, reason, reverses_movement_id, idempotency_key, actor_id)
         values ($1, 'estorno', $2, $3, $4, $5, $6) returning id`,
        [original.variant_id, delta, input.reason, original.id, input.idempotencyKey, actorId],
      );
      await recordAudit(tx, {
        actorId,
        action: 'stock.reverse',
        entity: 'stock_movement',
        entityId: movement.id,
        payload: { reverses: original.id, reason: input.reason },
      });
      return {
        movement: await getMovement(tx, movement.id),
        stock: await currentStock(tx, original.variant_id),
        created: true,
      };
    });
  } catch (err) {
    return translateStockError(err);
  }
}

export async function listMovements(
  pool: pg.Pool,
  query: MovementListQuery,
): Promise<Paginated<StockMovementDTO>> {
  const params: unknown[] = [];
  let where = '';
  if (query.variantId) {
    params.push(query.variantId);
    where = 'where m.variant_id = $1';
  }
  const total = Number(
    (await one<{ count: string }>(pool, `select count(*) from stock_movements m ${where}`, params))
      .count,
  );
  params.push(query.pageSize, (query.page - 1) * query.pageSize);
  const rows = await many<MovementRow>(
    pool,
    `${MOVEMENT_SELECT} ${where}
     order by m.created_at desc, m.id desc
     limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { items: rows.map(movementDTO), page: query.page, pageSize: query.pageSize, total };
}

export async function listLowStock(pool: pg.Pool): Promise<VariantDTO[]> {
  const rows = await many<{
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
  }>(
    pool,
    `select v.id, v.product_id, v.sku, v.barcode, v.size, v.color, v.price_cents, v.cost_cents,
            v.min_stock, v.active, coalesce(s.quantity, 0)::int as stock
     from product_variants v
     join products p on p.id = v.product_id and p.active
     left join stock_levels s on s.variant_id = v.id
     where v.active and coalesce(s.quantity, 0) <= v.min_stock
     order by coalesce(s.quantity, 0), v.sku
     limit 200`,
  );
  return rows.map((v) => ({
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
  }));
}
