export type ManualCatalogFormValues = {
  name: string;
  sku: string;
  salePrice: string;
  cost: string;
  initialQuantity: string;
};

function parseMoney(value: string): number {
  const normalized = value.trim().replace(".", "").replace(",", ".");
  if (normalized === "") return 0;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Informe um valor monetário válido.");

  return Math.round(parsed * 100);
}

export function toCents(value: string): number {
  return parseMoney(value);
}

export function toManualCatalogRequest(
  values: ManualCatalogFormValues,
  operationId: string,
) {
  const initialQuantity = Number(values.initialQuantity.trim() || "0");
  if (!Number.isInteger(initialQuantity) || initialQuantity < 0) {
    throw new Error("A quantidade inicial deve ser um número inteiro igual ou maior que zero.");
  }

  return {
    name: values.name.trim(),
    sku: values.sku.trim(),
    salePriceInCents: toCents(values.salePrice),
    costInCents: toCents(values.cost),
    initialQuantity,
    operationId,
  };
}
