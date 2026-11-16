import assert from "node:assert/strict";
import { test } from "node:test";

import { calculateWeightedAverageCost } from "./inventory-domain.js";

test("replaces_unit_cost_when_current_quantity_is_zero", () => {
  assert.equal(calculateWeightedAverageCost({
    currentQuantity: 0, currentUnitCostInCents: 9999, incomingQuantity: 5, incomingUnitCostInCents: 1300,
  }), 1300);
});

test("weights_existing_and_incoming_stock_cost", () => {
  assert.equal(calculateWeightedAverageCost({
    currentQuantity: 10, currentUnitCostInCents: 1000, incomingQuantity: 5, incomingUnitCostInCents: 1300,
  }), 1100);
});

test("rounds_nonnegative_half_cent_up_and_preserves_zero_cost", () => {
  assert.equal(calculateWeightedAverageCost({
    currentQuantity: 1, currentUnitCostInCents: 1000, incomingQuantity: 1, incomingUnitCostInCents: 1001,
  }), 1001);
  assert.equal(calculateWeightedAverageCost({
    currentQuantity: 10, currentUnitCostInCents: 0, incomingQuantity: 5, incomingUnitCostInCents: 0,
  }), 0);
});

test("rejects_negative_fractional_and_unsafe_values_before_arithmetic", () => {
  const input = { currentQuantity: 10, currentUnitCostInCents: 1000, incomingQuantity: 5, incomingUnitCostInCents: 1300 };
  for (const field of Object.keys(input)) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => calculateWeightedAverageCost({ ...input, [field]: value }), RangeError);
    }
  }
});

test("rejects_empty_total_and_unsafe_weighted_numerator_or_quantity", () => {
  for (const input of [
    { currentQuantity: 0, currentUnitCostInCents: 0, incomingQuantity: 0, incomingUnitCostInCents: 0 },
    { currentQuantity: Number.MAX_SAFE_INTEGER, currentUnitCostInCents: 2, incomingQuantity: 0, incomingUnitCostInCents: 0 },
    { currentQuantity: Number.MAX_SAFE_INTEGER, currentUnitCostInCents: 1, incomingQuantity: 1, incomingUnitCostInCents: 0 },
  ]) {
    assert.throws(() => calculateWeightedAverageCost(input), RangeError);
  }
});
