export type CatalogVariantRecord = {
  id: string;
  sku: string;
  sale_price_in_cents: number;
  requires_cost_review: boolean;
  product: { name: string } | null;
  inventory_balance: { quantity: number } | null;
};

export type CatalogRow = {
  id: string;
  sku: string;
  name: string;
  salePriceInCents: number;
  quantity: number | undefined;
  requiresCostReview: boolean;
};

export function toCatalogRows(records: CatalogVariantRecord[]): CatalogRow[] {
  return records.map((record) => ({
    id: record.id,
    sku: record.sku,
    name: record.product?.name ?? "Produto sem nome",
    salePriceInCents: record.sale_price_in_cents,
    quantity: record.inventory_balance?.quantity,
    requiresCostReview: record.requires_cost_review,
  }));
}
