import { describe, expect, it } from "vitest";

import {
  CatalogImportCandidateSchema,
  RecordStockReplenishmentInputSchema,
} from "./catalog-import";

describe("catalog contracts", () => {
  it("rejects a replenishment without a positive quantity", () => {
    expect(() =>
      RecordStockReplenishmentInputSchema.parse({
        variantId: "e30ed00e-61a6-4685-8b3b-35f0fd65c65e",
        quantity: 0,
        unitCostInCents: 2500,
      }),
    ).toThrow();
  });

  it("marks an imported variant without cost for margin review", () => {
    expect(
      CatalogImportCandidateSchema.parse({
        externalProductId: "100",
        externalVariantId: "101",
        name: "Camiseta básica",
        sku: "CAM-001-P",
        salePriceInCents: 4990,
        costInCents: 0,
        requiresCostReview: true,
        tracksInventory: true,
        stockQuantity: 3,
        attributes: [{ name: "Tamanho", value: "P" }],
      }),
    ).toMatchObject({ requiresCostReview: true, costInCents: 0 });
  });
});
