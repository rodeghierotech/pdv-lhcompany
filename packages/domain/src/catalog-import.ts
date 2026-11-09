import {
  CatalogImportCandidateSchema,
  type CatalogImportCandidate,
} from "../../contracts/src/catalog-import";

type NuvemshopInventoryLevel = {
  locationId: string;
  stock: number;
};

type NuvemshopVariantInput = {
  productId: number;
  variantId: number;
  name: string;
  sku: string;
  price: string;
  cost: string | null;
  stockManagement: boolean;
  attributes: Array<{ name: string; value: string }>;
  inventoryLevels: NuvemshopInventoryLevel[];
};

function moneyToCents(value: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Valor monetário inválido recebido da Nuvemshop.");
  }

  return Math.round(parsed * 100);
}

export function normalizeNuvemshopVariant(
  input: NuvemshopVariantInput,
  defaultLocationId: string,
): CatalogImportCandidate {
  const inventoryLevel = input.inventoryLevels.find(
    (level) => level.locationId === defaultLocationId,
  );
  const costInCents = input.cost === null ? 0 : moneyToCents(input.cost);

  return CatalogImportCandidateSchema.parse({
    externalProductId: String(input.productId),
    externalVariantId: String(input.variantId),
    name: input.name,
    sku: input.sku,
    salePriceInCents: moneyToCents(input.price),
    costInCents,
    requiresCostReview: input.cost === null,
    tracksInventory: input.stockManagement,
    stockQuantity: inventoryLevel?.stock ?? 0,
    attributes: input.attributes,
  });
}
