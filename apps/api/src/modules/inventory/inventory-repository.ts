import {
  InventoryHistoryResponseSchema,
  type InventoryHistoryQuery,
  type InventoryHistoryResponse,
} from "@lh-company/contracts";
import type { PoolClient } from "pg";

export interface InventoryOperation {
  variantId: string;
  fingerprint: string | null;
}

interface LockedVariant {
  costInCents: number;
  productActive: boolean;
  variantActive: boolean;
  tracksInventory: boolean;
}

interface ReplenishmentInsertion {
  variantId: string;
  lotId: string;
  movementId: string;
  operationId: string;
  fingerprint: string;
  quantity: number;
  unitCostInCents: number;
  sourceReference: string | null;
  occurredAt: Date;
  newQuantity: number;
  newCostInCents: number;
}

export interface InventoryRepository {
  findByOperationId(client: PoolClient, operationId: string): Promise<InventoryOperation | undefined>;
  lockVariant(client: PoolClient, variantId: string): Promise<LockedVariant | undefined>;
  lockBalance(client: PoolClient, variantId: string): Promise<number>;
  insert(client: PoolClient, insertion: ReplenishmentInsertion): Promise<void>;
  getHistory(client: PoolClient, variantId: string, query: InventoryHistoryQuery): Promise<InventoryHistoryResponse | undefined>;
}

export function createInventoryRepository(): InventoryRepository {
  return {
    async findByOperationId(client, operationId) {
      const result = await client.query<{ variant_id: string; operation_fingerprint: string | null }>(`
        SELECT variant_id, operation_fingerprint FROM inventory_movement WHERE operation_id = $1
      `, [operationId]);
      const row = result.rows[0];
      return row ? { variantId: row.variant_id, fingerprint: row.operation_fingerprint } : undefined;
    },
    async lockVariant(client, variantId) {
      const result = await client.query<{
        cost_in_cents: number; product_active: boolean; variant_active: boolean; tracks_inventory: boolean;
      }>(`
        SELECT variant.cost_in_cents, product.active AS product_active,
               variant.active AS variant_active, variant.tracks_inventory
        FROM product_variant AS variant JOIN product ON product.id = variant.product_id
        WHERE variant.id = $1 FOR UPDATE OF variant, product
      `, [variantId]);
      const row = result.rows[0];
      return row ? {
        costInCents: row.cost_in_cents, productActive: row.product_active,
        variantActive: row.variant_active, tracksInventory: row.tracks_inventory,
      } : undefined;
    },
    async lockBalance(client, variantId) {
      // The variant lock serializes even the first replenishment when a balance is missing.
      await client.query(`
        INSERT INTO inventory_balance (variant_id, quantity) VALUES ($1, 0) ON CONFLICT DO NOTHING
      `, [variantId]);
      const result = await client.query<{ quantity: number }>(`
        SELECT quantity FROM inventory_balance WHERE variant_id = $1 FOR UPDATE
      `, [variantId]);
      if (!result.rows[0]) {
        throw new Error("Saldo de estoque ausente após bloqueio da variante.");
      }
      return result.rows[0].quantity;
    },
    async insert(client, insertion) {
      await client.query(`
        INSERT INTO stock_lot (id, variant_id, received_at, unit_cost_in_cents, source_reference)
        VALUES ($1, $2, $3, $4, $5)
      `, [insertion.lotId, insertion.variantId, insertion.occurredAt, insertion.unitCostInCents, insertion.sourceReference]);
      await client.query(`
        INSERT INTO inventory_movement (
          id, variant_id, lot_id, reason, quantity_delta, operation_id, operation_fingerprint, occurred_at
        ) VALUES ($1, $2, $3, 'replenishment', $4, $5, $6, $7)
      `, [insertion.movementId, insertion.variantId, insertion.lotId, insertion.quantity,
        insertion.operationId, insertion.fingerprint, insertion.occurredAt]);
      await client.query(`
        UPDATE inventory_balance SET quantity = $2, updated_at = $3 WHERE variant_id = $1
      `, [insertion.variantId, insertion.newQuantity, insertion.occurredAt]);
      await client.query(`
        UPDATE product_variant SET cost_in_cents = $2, updated_at = $3 WHERE id = $1
      `, [insertion.variantId, insertion.newCostInCents, insertion.occurredAt]);
    },
    async getHistory(client, variantId, query) {
      // One SQL snapshot keeps the balance/cost and movement window consistent during writes.
      const result = await client.query<{
        variant_id: string; product_id: string; product_name: string; sku: string; attributes: unknown;
        quantity: number; cost_in_cents: number; movements: unknown;
      }>(`
        SELECT variant.id AS variant_id, product.id AS product_id, product.name AS product_name,
               variant.sku, variant.attributes, COALESCE(balance.quantity, 0) AS quantity,
               variant.cost_in_cents,
               COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                   'id', movement.id, 'variantId', movement.variant_id, 'lotId', movement.lot_id,
                   'reason', movement.reason, 'quantityDelta', movement.quantity_delta,
                   'referenceId', movement.reference_id, 'operationId', movement.operation_id,
                   'sourceReference', movement.source_reference, 'occurredAt', movement.occurred_at
                 ) ORDER BY movement.occurred_at DESC, movement.id DESC)
                 FROM (
                   SELECT entry.*, lot.source_reference
                   FROM inventory_movement AS entry LEFT JOIN stock_lot AS lot ON lot.id = entry.lot_id
                   WHERE entry.variant_id = variant.id
                   ORDER BY entry.occurred_at DESC, entry.id DESC LIMIT $2
                 ) AS movement
               ), '[]'::JSONB) AS movements
        FROM product_variant AS variant JOIN product ON product.id = variant.product_id
        LEFT JOIN inventory_balance AS balance ON balance.variant_id = variant.id
        WHERE variant.id = $1
      `, [variantId, query.limit]);
      const row = result.rows[0];
      return row ? InventoryHistoryResponseSchema.parse({
        variantId: row.variant_id, productId: row.product_id, productName: row.product_name,
        sku: row.sku, attributes: row.attributes, quantity: row.quantity, costInCents: row.cost_in_cents,
        estimatedStockCostInCents: row.quantity * row.cost_in_cents, movements: row.movements,
      }) : undefined;
    },
  };
}
