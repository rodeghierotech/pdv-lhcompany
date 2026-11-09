export type ReplenishmentFormValues = {
  quantity: string;
  unitCost: string;
  sourceReference: string;
};

function toCents(value: string): number {
  const normalized = value.trim().replace(".", "").replace(",", ".");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Informe um custo unitário válido.");
  return Math.round(parsed * 100);
}

export function toReplenishmentRequest(values: ReplenishmentFormValues, variantId: string, operationId: string) {
  const quantity = Number(values.quantity.trim());
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("A quantidade da reposição deve ser um inteiro positivo.");

  const request = {
    variantId,
    quantity,
    unitCostInCents: toCents(values.unitCost),
    operationId,
  };

  const sourceReference = values.sourceReference.trim();
  return sourceReference === "" ? request : { ...request, sourceReference };
}
