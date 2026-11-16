interface WeightedAverageCostInput {
  currentQuantity: number;
  currentUnitCostInCents: number;
  incomingQuantity: number;
  incomingUnitCostInCents: number;
}

export function calculateWeightedAverageCost(input: WeightedAverageCostInput): number {
  for (const value of Object.values(input)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Quantidade e custo devem ser inteiros não negativos seguros.");
    }
  }
  const quantity = input.currentQuantity + input.incomingQuantity;
  const numerator = input.currentQuantity * input.currentUnitCostInCents
    + input.incomingQuantity * input.incomingUnitCostInCents;
  if (!Number.isSafeInteger(quantity) || quantity === 0 || !Number.isSafeInteger(numerator)) {
    throw new RangeError("O cálculo de custo excede os limites permitidos.");
  }
  return Math.round(numerator / quantity);
}
