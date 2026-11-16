import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { CreateProductCommandSchema, InventoryHistoryQuerySchema, type CreateReplenishmentCommand } from "@lh-company/contracts";

import { runMigrations } from "../../infrastructure/migration-runner.js";
import { getTestDatabasePool, resetProductInventoryTables } from "../../test/database-test-support.js";
import { createProductRepository } from "../products/product-repository.js";
import { createProductService } from "../products/product-service.js";
import { InventoryOperationNotAllowedError, InventoryVariantNotFoundError, OperationPayloadConflictError } from "./inventory-errors.js";
import { createInventoryRepository } from "./inventory-repository.js";
import { createInventoryService } from "./inventory-service.js";

const database = getTestDatabasePool();
const repository = createInventoryRepository();
const service = createInventoryService({ database, repository });
const products = createProductService({ database, repository: createProductRepository() });
const historyQuery = InventoryHistoryQuerySchema.parse({});

before(async () => { await runMigrations(database); });
beforeEach(async () => { await resetProductInventoryTables(database); });
after(async () => {
  try { await resetProductInventoryTables(database); } finally { await database.end(); }
});

async function variant() {
  const product = await products.create(CreateProductCommandSchema.parse({
    operationId: randomUUID(),
    product: {
      name: "Camiseta", description: null, category: null, active: true,
      variants: [{ sku: randomUUID(), barcode: null, attributes: [{ name: "Tamanho", value: "M" }],
        salePriceInCents: 3000, costInCents: 1000, tracksInventory: true, active: true }],
    },
  }));
  return product.variants[0]!.id;
}

function command(variantId: string): CreateReplenishmentCommand {
  return { operationId: randomUUID(), variantId, quantity: 5, unitCostInCents: 1300, sourceReference: "NF 123" };
}

async function storedState(variantId: string) {
  const result = await database.query<{ quantity: number | null; cost: number; lots: number; movements: number }>(`
    SELECT (SELECT quantity FROM inventory_balance WHERE variant_id = variant.id) AS quantity,
           cost_in_cents AS cost,
           (SELECT COUNT(*)::INT FROM stock_lot WHERE variant_id = variant.id) AS lots,
           (SELECT COUNT(*)::INT FROM inventory_movement WHERE variant_id = variant.id) AS movements
    FROM product_variant AS variant WHERE id = $1
  `, [variantId]);
  return result.rows[0];
}

// Force both real transactions to observe no prior operation before either mutates.
function concurrentService() {
  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => { release = resolve; });
  return createInventoryService({
    database,
    repository: {
      ...repository,
      async findByOperationId(client, operationId) {
        const operation = await repository.findByOperationId(client, operationId);
        reads += 1;
        if (reads === 2) { release(); }
        if (reads <= 2) { await bothRead; }
        return operation;
      },
    },
  });
}

test("creates_lot_positive_movement_and_balance_with_weighted_cost_atomically", async () => {
  const variantId = await variant();
  await service.replenish({ ...command(variantId), quantity: 10, unitCostInCents: 1000 });
  const input = command(variantId);
  const result = await service.replenish(input);
  assert.equal(result.quantity, 15);
  assert.equal(result.costInCents, 1100);
  assert.equal(result.estimatedStockCostInCents, 16500);
  assert.equal(result.productName, "Camiseta");
  assert.equal(result.movements.length, 2);
  const movement = result.movements.find((item) => item.operationId === input.operationId)!;
  assert.equal(movement.quantityDelta, 5);
  assert.equal(movement.reason, "replenishment");
  assert.equal(movement.sourceReference, "NF 123");
  assert.equal(movement.referenceId, null);
  assert.ok(movement.lotId);
  assert.deepEqual(await storedState(variantId), { quantity: 15, cost: 1100, lots: 2, movements: 2 });
});

test("samples_the_server_clock_once_for_lot_and_movement", async () => {
  const variantId = await variant();
  let samples = 0;
  const instant = new Date("2026-11-14T15:23:45.678Z");
  const timed = createInventoryService({ database, repository, clock: () => { samples += 1; return instant; } });
  const result = await timed.replenish(command(variantId));
  const lot = await database.query<{ received_at: Date }>("SELECT received_at FROM stock_lot");
  assert.equal(samples, 1);
  assert.equal(lot.rows[0]?.received_at.toISOString(), instant.toISOString());
  assert.equal(new Date(result.movements[0]!.occurredAt).toISOString(), instant.toISOString());
});

for (const [incomingQuantity, expectedQuantity, expectedEstimate] of [[1, -2, -2600], [3, 0, 0], [5, 2, 2600]] as const) {
  test(`replenishes_audited_deficit_to_${expectedQuantity}_without_clamping_or_duplicate_movements`, async () => {
    const variantId = await variant();
    const saleMovementId = randomUUID();
    const saleId = randomUUID();
    await database.query(`
      WITH movement AS (
        INSERT INTO inventory_movement (id, variant_id, reason, quantity_delta, reference_id, occurred_at)
        VALUES ($1, $2, 'physical_sale', -3, $3, NOW()) RETURNING quantity_delta
      )
      UPDATE inventory_balance SET quantity = quantity + movement.quantity_delta
      FROM movement WHERE variant_id = $2
    `, [saleMovementId, variantId, saleId]);
    const input = { ...command(variantId), quantity: incomingQuantity };
    const result = await service.replenish(input);
    assert.equal(result.quantity, expectedQuantity);
    assert.equal(result.costInCents, 1300);
    assert.equal(result.estimatedStockCostInCents, expectedEstimate);
    assert.deepEqual(await service.replenish(input), result);
    assert.deepEqual(await storedState(variantId), { quantity: expectedQuantity, cost: 1300, lots: 1, movements: 2 });
    const original = result.movements.find((movement) => movement.id === saleMovementId);
    assert.equal(original?.quantityDelta, -3);
    assert.equal(original?.reason, "physical_sale");
    assert.equal(original?.referenceId, saleId);
    assert.equal(result.movements.find((movement) => movement.operationId === input.operationId)?.quantityDelta, incomingQuantity);
  });
}

test("default_server_clock_records_the_actual_mutation_time", async () => {
  const variantId = await variant();
  const before = Date.now();
  const result = await service.replenish(command(variantId));
  const after = Date.now();
  const time = new Date(result.movements[0]!.occurredAt).getTime();
  assert.ok(time >= before && time <= after);
});

test("rolls_back_lot_movement_balance_and_cost_on_failure_after_all_writes", async () => {
  const variantId = await variant();
  await service.replenish({ ...command(variantId), quantity: 10, unitCostInCents: 1000 });
  const failing = createInventoryService({
    database,
    repository: { ...repository, async insert(client, insertion) {
      await repository.insert(client, insertion);
      throw new Error("forced transaction failure");
    } },
  });
  await assert.rejects(failing.replenish(command(variantId)), /forced transaction failure/);
  assert.deepEqual(await storedState(variantId), { quantity: 10, cost: 1000, lots: 1, movements: 1 });
});

test("creates_missing_balance_transactionally_and_rolls_it_back_on_failure", async () => {
  const variantId = await variant();
  await database.query("DELETE FROM inventory_balance WHERE variant_id = $1", [variantId]);
  const failing = createInventoryService({ database, repository: { ...repository, async insert(client, insertion) {
    await repository.insert(client, insertion);
    throw new Error("forced failure");
  } } });
  await assert.rejects(failing.replenish(command(variantId)), /forced failure/);
  assert.deepEqual(await storedState(variantId), { quantity: null, cost: 1000, lots: 0, movements: 0 });
  assert.equal((await service.replenish(command(variantId))).quantity, 5);
});

test("replays_normalized_payload_without_duplicate_writes_or_resampling_clock", async () => {
  const variantId = await variant();
  const input = command(variantId);
  const first = await service.replenish(input);
  const replayService = createInventoryService({ database, repository, clock: () => { throw new Error("replay must not sample clock"); } });
  assert.deepEqual(await replayService.replenish({ ...input, sourceReference: "  NF 123  " }), first);
  assert.deepEqual(await storedState(variantId), { quantity: 5, cost: 1300, lots: 1, movements: 1 });
});

test("rejects_operation_reuse_when_any_replenishment_field_differs", async () => {
  const variantId = await variant();
  const otherVariantId = await variant();
  const input = command(variantId);
  await service.replenish(input);
  for (const difference of [
    { variantId: otherVariantId }, { quantity: 6 }, { unitCostInCents: 1301 }, { sourceReference: "Outra NF" },
  ]) {
    await assert.rejects(service.replenish({ ...input, ...difference }),
      (error) => error instanceof OperationPayloadConflictError && error.code === "OPERATION_PAYLOAD_CONFLICT");
  }
  assert.deepEqual(await storedState(variantId), { quantity: 5, cost: 1300, lots: 1, movements: 1 });
});

test("serializes_concurrent_replenishments_without_lost_quantity_or_cost_updates", async () => {
  const variantId = await variant();
  await service.replenish({ ...command(variantId), quantity: 10, unitCostInCents: 1000 });
  const concurrent = concurrentService();
  await Promise.all([
    concurrent.replenish(command(variantId)),
    concurrent.replenish({ ...command(variantId), unitCostInCents: 1600 }),
  ]);
  assert.deepEqual(await storedState(variantId), { quantity: 20, cost: 1225, lots: 3, movements: 3 });
});

test("deduplicates_concurrent_identical_operations_on_the_same_variant", async () => {
  const variantId = await variant();
  const input = command(variantId);
  const concurrent = concurrentService();
  const results = await Promise.all([concurrent.replenish(input), concurrent.replenish(input)]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(await storedState(variantId), { quantity: 5, cost: 1300, lots: 1, movements: 1 });
});

test("concurrent_operation_reuse_on_different_variants_commits_only_one_payload", async () => {
  const firstVariant = await variant();
  const secondVariant = await variant();
  const input = command(firstVariant);
  const concurrent = concurrentService();
  const results = await Promise.allSettled([
    concurrent.replenish(input), concurrent.replenish({ ...input, variantId: secondVariant }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.ok(rejection?.status === "rejected" && rejection.reason instanceof OperationPayloadConflictError);
  const state = await database.query<{ lots: number; movements: number; quantity: string }>(`
    SELECT (SELECT COUNT(*)::INT FROM stock_lot) AS lots,
           (SELECT COUNT(*)::INT FROM inventory_movement) AS movements,
           (SELECT SUM(quantity) FROM inventory_balance) AS quantity
  `);
  assert.deepEqual(state.rows[0], { lots: 1, movements: 1, quantity: "5" });
});

test("rejects_missing_inactive_or_untracked_variants_without_inventory_writes", async () => {
  await assert.rejects(service.replenish(command(randomUUID())), InventoryVariantNotFoundError);
  for (const update of [
    "UPDATE product SET active = FALSE", "UPDATE product_variant SET active = FALSE",
    "UPDATE product_variant SET tracks_inventory = FALSE",
  ]) {
    await resetProductInventoryTables(database);
    const variantId = await variant();
    await database.query(update);
    await assert.rejects(service.replenish(command(variantId)), InventoryOperationNotAllowedError);
    assert.deepEqual(await storedState(variantId), { quantity: 0, cost: 1000, lots: 0, movements: 0 });
  }
});

test("replay_returns_current_snapshot_with_latest_50_history_even_if_original_is_older", async () => {
  const variantId = await variant();
  let index = 0;
  const timed = createInventoryService({ database, repository, clock: () => new Date(Date.UTC(2026, 10, 14, 12, 0, index++)) });
  const input = command(variantId);
  await timed.replenish(input);
  for (let count = 0; count < 51; count += 1) {
    await timed.replenish(command(variantId));
  }
  const replay = await timed.replenish(input);
  assert.equal(replay.quantity, 260);
  assert.equal(replay.movements.length, 50);
  assert.equal(replay.movements.some((movement) => movement.operationId === input.operationId), false);
  assert.deepEqual(await storedState(variantId), { quantity: 260, cost: 1300, lots: 52, movements: 52 });
});

test("history_includes_signed_movements_and_orders_by_timestamp_then_id_with_requested_limit", async () => {
  const variantId = await variant();
  const time = "2026-11-14T15:00:00Z";
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
  await database.query(`
    INSERT INTO inventory_movement (id, variant_id, reason, quantity_delta, occurred_at)
    VALUES ($1, $3, 'adjustment', 3, $4), ($2, $3, 'physical_sale', -1, $4)
  `, [...ids, variantId, time]);
  await database.query("UPDATE inventory_balance SET quantity = 2 WHERE variant_id = $1", [variantId]);
  const history = await service.getHistory(variantId, InventoryHistoryQuerySchema.parse({ limit: "1" }));
  assert.equal(history.quantity, 2);
  assert.equal(history.estimatedStockCostInCents, 2000);
  assert.deepEqual(history.movements.map((item) => [item.id, item.quantityDelta, item.lotId, item.operationId, item.sourceReference]),
    [[ids[1], -1, null, null, null]]);
  const full = await service.getHistory(variantId, historyQuery);
  assert.deepEqual(full.movements.map((item) => item.id), [ids[1], ids[0]]);
  await assert.rejects(service.getHistory(randomUUID(), historyQuery), InventoryVariantNotFoundError);
});
