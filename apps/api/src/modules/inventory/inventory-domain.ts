interface WeightedAverageCostInput {
  currentQuantity: number;
  currentUnitCostInCents: number;
  incomingQuantity: number;
  incomingUnitCostInCents: number;
}

export function calculateWeightedAverageCost(input: WeightedAverageCostInput): number {
  for (const [field, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || (field !== "currentQuantity" && value < 0)) {
      throw new RangeError("Quantidade deve ser inteira segura; entrada e custos não podem ser negativos.");
    }
  }
  // A deficit carries no remaining units to weight. Keep the signed balance in
  // the service/ledger, while valuing the incoming units at their received cost.
  const costBearingQuantity = Math.max(0, input.currentQuantity);
  const quantity = costBearingQuantity + input.incomingQuantity;
  const numerator = costBearingQuantity * input.currentUnitCostInCents
    + input.incomingQuantity * input.incomingUnitCostInCents;
  if (!Number.isSafeInteger(input.currentQuantity + input.incomingQuantity)
    || !Number.isSafeInteger(quantity) || quantity === 0 || !Number.isSafeInteger(numerator)) {
    throw new RangeError("O cálculo de custo excede os limites permitidos.");
  }
  return Math.round(numerator / quantity);
}
