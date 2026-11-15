import assert from "node:assert/strict";
import { test } from "node:test";
import * as contracts from "./index.js";

const variantId = "6c115211-6b97-4b98-ae6e-7157ab973c50";
const operationId = "a8d17203-3527-442c-824b-bbc59ad41a5b";
const command = { operationId, variantId, quantity: 5, unitCostInCents: 1_300 };
const movement = {
  id: "f9562c58-4d4a-47bc-a25c-6934e572206f",
  variantId,
  lotId: null,
  reason: "physical_sale",
  quantityDelta: -2,
  referenceId: null,
  operationId,
  sourceReference: null,
  occurredAt: "2026-11-14T15:00:00Z",
};

test("accepts_positive_replenishment", () => {
  const result = contracts.CreateReplenishmentCommandSchema.parse({ ...command, sourceReference: "  NF 123  " });
  assert.equal(result.quantity, 5);
  assert.equal(result.unitCostInCents, 1_300);
  assert.equal(result.sourceReference, "NF 123");
  assert.equal(contracts.CreateReplenishmentCommandSchema.parse(command).sourceReference, undefined);
});

test("rejects_zero_quantity", () => {
  assert.equal(contracts.CreateReplenishmentCommandSchema.safeParse({ ...command, quantity: 0 }).success, false);
});

test("rejects_fractional_quantity", () => {
  assert.equal(contracts.CreateReplenishmentCommandSchema.safeParse({ ...command, quantity: 1.5 }).success, false);
});

test("rejects_negative_unit_cost", () => {
  assert.equal(contracts.CreateReplenishmentCommandSchema.safeParse({ ...command, unitCostInCents: -1 }).success, false);
});

test("rejects_client_supplied_occurred_at", () => {
  assert.equal(contracts.CreateReplenishmentCommandSchema.safeParse({
    ...command, occurredAt: "2020-01-01T00:00:00Z",
  }).success, false);
});

test("parses_signed_history_quantity", () => {
  assert.equal(contracts.InventoryHistoryItemSchema.parse(movement).quantityDelta, -2);
  assert.equal(contracts.InventoryHistoryItemSchema.parse({ ...movement, reason: "replenishment", quantityDelta: 5 }).quantityDelta, 5);
});

test("rejects_invalid_replenishment_money_quantity_and_reference", () => {
  for (const fields of [{ quantity: -1 }, { unitCostInCents: 1.5 }, { sourceReference: "x".repeat(201) }]) {
    assert.equal(contracts.CreateReplenishmentCommandSchema.safeParse({ ...command, ...fields }).success, false);
  }
  assert.equal(contracts.CreateReplenishmentCommandSchema.parse({ ...command, unitCostInCents: 0 }).unitCostInCents, 0);
});

test("rejects_zero_or_fractional_history_movements", () => {
  for (const quantityDelta of [0, 0.5]) {
    assert.equal(contracts.InventoryHistoryItemSchema.safeParse({ ...movement, quantityDelta }).success, false);
  }
});

test("parses_flat_inventory_history_response", () => {
  const result = contracts.InventoryHistoryResponseSchema.parse({
    variantId,
    productId: "0c7e8828-030c-4cad-9e6c-05af28bf0510",
    productName: "Camiseta",
    sku: "CAM-M",
    attributes: [{ name: "Tamanho", value: "M" }],
    quantity: 3,
    costInCents: 1_300,
    estimatedStockCostInCents: 3_900,
    movements: [movement, { ...movement, id: operationId, quantityDelta: 5, reason: "replenishment", occurredAt: "2026-11-13T15:00:00Z" }],
  });
  assert.equal(result.quantity, 3);
  assert.equal(result.costInCents, 1_300);
  assert.equal(result.estimatedStockCostInCents, 3_900);
  assert.deepEqual(result.movements.map((item) => item.quantityDelta), [-2, 5]);
});
