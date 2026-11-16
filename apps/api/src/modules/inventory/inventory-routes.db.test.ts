import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { Writable } from "node:stream";

import {
  CreateProductCommandSchema, InventoryHistoryResponseSchema,
  type CreateReplenishmentCommand,
} from "@lh-company/contracts";
import Fastify from "fastify";

import { createApp } from "../../app.js";
import { runMigrations } from "../../infrastructure/migration-runner.js";
import { getTestDatabasePool, resetProductInventoryTables } from "../../test/database-test-support.js";
import { createProductRepository } from "../products/product-repository.js";
import { createProductService } from "../products/product-service.js";
import { createInventoryRepository } from "./inventory-repository.js";
import { registerInventoryRoutes } from "./inventory-routes.js";
import { createInventoryService } from "./inventory-service.js";

const database = getTestDatabasePool();
const products = createProductService({ database, repository: createProductRepository() });
const service = createInventoryService({ database, repository: createInventoryRepository() });
const app = createApp({ database });

before(async () => { await runMigrations(database); await app.ready(); });
beforeEach(async () => { await resetProductInventoryTables(database); });
after(async () => {
  await app.close();
  try { await resetProductInventoryTables(database); } finally { await database.end(); }
});

async function variant() {
  const product = await products.create(CreateProductCommandSchema.parse({
    operationId: randomUUID(),
    product: {
      name: "Camiseta", description: null, category: null, active: true,
      variants: [{ sku: "CAM-M", barcode: null, attributes: [], salePriceInCents: 3000,
        costInCents: 1000, tracksInventory: true, active: true }],
    },
  }));
  return product.variants[0]!.id;
}

function command(variantId: string): CreateReplenishmentCommand {
  return { operationId: randomUUID(), variantId, quantity: 5, unitCostInCents: 1300 };
}

test("post_replenishes_and_replays_with_201_server_computed_balance_cost_and_history", async () => {
  const variantId = await variant();
  await service.replenish({ ...command(variantId), quantity: 10, unitCostInCents: 1000 });
  const input = { ...command(variantId), sourceReference: "  NF 123  " };
  const before = Date.now();
  const response = await app.inject({ method: "POST", url: "/inventory/replenishments", payload: input });
  assert.equal(response.statusCode, 201, response.body);
  const snapshot = InventoryHistoryResponseSchema.parse(response.json());
  assert.equal(snapshot.quantity, 15);
  assert.equal(snapshot.costInCents, 1100);
  assert.equal(snapshot.estimatedStockCostInCents, 16500);
  assert.equal(snapshot.movements[0]?.operationId, input.operationId);
  assert.equal(snapshot.movements[0]?.sourceReference, "NF 123");
  assert.ok(new Date(snapshot.movements[0]!.occurredAt).getTime() >= before);
  const replay = await app.inject({ method: "POST", url: "/inventory/replenishments", payload: input });
  assert.equal(replay.statusCode, 201, replay.body);
  assert.deepEqual(replay.json(), snapshot);
  const history = await app.inject({ method: "GET", url: `/inventory/variants/${variantId}/history` });
  assert.equal(history.statusCode, 200, history.body);
  assert.deepEqual(history.json(), snapshot);
});

test("get_history_uses_shared_default_and_maximum_limit_and_stable_descending_order", async () => {
  const variantId = await variant();
  // Immutable ledger fixtures with tied timestamps exercise the public tie-break order.
  const ids = Array.from({ length: 102 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
  await database.query(`
    INSERT INTO inventory_movement (id, variant_id, reason, quantity_delta, occurred_at)
    SELECT id, $1, 'adjustment', 1,
           CASE WHEN id = $3::UUID THEN '2026-11-15T15:00:00Z'::TIMESTAMPTZ
                ELSE '2026-11-14T15:00:00Z'::TIMESTAMPTZ END
    FROM unnest($2::UUID[]) AS id
  `, [variantId, ids, ids[0]]);
  await database.query("UPDATE inventory_balance SET quantity = 102 WHERE variant_id = $1", [variantId]);
  const ordered = [ids[0], ...ids.slice(1).reverse()];
  for (const [query, expectedLength] of [[{}, 50], [{ limit: "100" }, 100], [{ limit: "2" }, 2]] as const) {
    const response = await app.inject({ method: "GET", url: `/inventory/variants/${variantId}/history`, query });
    assert.equal(response.statusCode, 200, response.body);
    const result = InventoryHistoryResponseSchema.parse(response.json());
    assert.equal(result.quantity, 102);
    assert.equal(result.estimatedStockCostInCents, 102000);
    assert.deepEqual(result.movements.map((item) => item.id), ordered.slice(0, expectedLength));
  }
});

test("invalid_body_path_or_query_returns_400_without_inventory_writes", async () => {
  const variantId = await variant();
  const input = command(variantId);
  for (const payload of [
    {}, { ...input, operationId: "invalid" }, { ...input, variantId: "invalid" },
    { ...input, quantity: 0 }, { ...input, quantity: 0.5 }, { ...input, unitCostInCents: -1 },
    { ...input, occurredAt: "2000-01-01T00:00:00Z" }, { ...input, costInCents: 0 },
  ]) {
    const response = await app.inject({ method: "POST", url: "/inventory/replenishments", payload });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().code, "INVALID_REQUEST");
  }
  for (const query of [{ limit: "0" }, { limit: "1.5" }, { limit: "101" }, { cursor: "unsupported" }]) {
    const response = await app.inject({ method: "GET", url: `/inventory/variants/${variantId}/history`, query });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().code, "INVALID_REQUEST");
  }
  const invalidPath = await app.inject({ method: "GET", url: "/inventory/variants/invalid/history" });
  assert.equal(invalidPath.statusCode, 400, invalidPath.body);
  assert.equal(invalidPath.json().code, "INVALID_REQUEST");
  const count = await database.query<{ count: number }>("SELECT COUNT(*)::INT AS count FROM inventory_movement");
  assert.equal(count.rows[0]?.count, 0);
});

test("missing_variant_returns_public_404_for_replenishment_and_history", async () => {
  const variantId = randomUUID();
  for (const response of [
    await app.inject({ method: "POST", url: "/inventory/replenishments", payload: command(variantId) }),
    await app.inject({ method: "GET", url: `/inventory/variants/${variantId}/history` }),
  ]) {
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.json().code, "INVENTORY_VARIANT_NOT_FOUND");
  }
});

test("inactive_product_inactive_variant_and_untracked_variant_return_public_409", async () => {
  for (const update of [
    "UPDATE product SET active = FALSE", "UPDATE product_variant SET active = FALSE",
    "UPDATE product_variant SET tracks_inventory = FALSE",
  ]) {
    await resetProductInventoryTables(database);
    const variantId = await variant();
    await database.query(update);
    const response = await app.inject({ method: "POST", url: "/inventory/replenishments", payload: command(variantId) });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, "INVENTORY_OPERATION_NOT_ALLOWED");
    const history = await app.inject({ method: "GET", url: `/inventory/variants/${variantId}/history` });
    assert.equal(history.statusCode, 200, history.body);
    assert.deepEqual(history.json().movements, []);
  }
});

test("incompatible_replay_returns_public_payload_conflict_with_409", async () => {
  const input = command(await variant());
  await service.replenish(input);
  const response = await app.inject({
    method: "POST", url: "/inventory/replenishments", payload: { ...input, quantity: 6 },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, "OPERATION_PAYLOAD_CONFLICT");
});

test("unexpected_sql_error_is_logged_and_returns_safe_500_with_rollback", async () => {
  const variantId = await variant();
  const first = await service.replenish(command(variantId));
  let logs = "";
  const logStream = new Writable({ write(chunk: Buffer, _encoding, callback) { logs += chunk.toString(); callback(); } });
  const failureApp = Fastify({ logger: { stream: logStream } });
  await registerInventoryRoutes(failureApp, createInventoryService({
    database, repository: createInventoryRepository(), idFactory: () => first.movements[0]!.id,
  }));
  try {
    const response = await failureApp.inject({ method: "POST", url: "/inventory/replenishments", payload: command(variantId) });
    assert.equal(response.statusCode, 500, response.body);
    assert.deepEqual(response.json(), { code: "INTERNAL_ERROR", message: "Não foi possível concluir a operação." });
    const entries = logs.trim().split("\n").map((line) => JSON.parse(line) as { level: number; err?: { code?: string } });
    assert.ok(entries.some((entry) => entry.level === 50 && entry.err?.code === "23505"));
    const state = await database.query<{ lots: number; quantity: number }>(`
      SELECT (SELECT COUNT(*)::INT FROM stock_lot) AS lots, quantity FROM inventory_balance WHERE variant_id = $1
    `, [variantId]);
    assert.deepEqual(state.rows[0], { lots: 1, quantity: 5 });
  } finally { await failureApp.close(); }
});

test("invalid_stored_history_is_internal_error_instead_of_client_validation_error", async () => {
  const variantId = await variant();
  await database.query("UPDATE product_variant SET attributes = '{}'::JSONB WHERE id = $1", [variantId]);
  const response = await app.inject({ method: "GET", url: `/inventory/variants/${variantId}/history` });
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(response.json().code, "INTERNAL_ERROR");
});

test("inventory_has_no_edit_or_delete_endpoints", async () => {
  const variantId = await variant();
  for (const method of ["PUT", "PATCH", "DELETE"] as const) {
    const response = await app.inject({ method, url: `/inventory/variants/${variantId}/history` });
    assert.equal(response.statusCode, 404, response.body);
  }
});
