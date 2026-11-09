import { describe, expect, it } from "vitest";

import { normalizeNuvemshopVariant } from "./catalog-import";

describe("normalizeNuvemshopVariant", () => {
  it("uses the configured default location and flags a missing cost", () => {
    expect(
      normalizeNuvemshopVariant(
        {
          productId: 10,
          variantId: 20,
          name: "Camiseta",
          sku: "CAM-P",
          price: "49.90",
          cost: null,
          stockManagement: true,
          attributes: [{ name: "Tamanho", value: "P" }],
          inventoryLevels: [
            { locationId: "other", stock: 9 },
            { locationId: "physical", stock: 3 },
          ],
        },
        "physical",
      ),
    ).toMatchObject({
      externalProductId: "10",
      externalVariantId: "20",
      salePriceInCents: 4990,
      costInCents: 0,
      requiresCostReview: true,
      stockQuantity: 3,
    });
  });

  it("rejects a payload without a SKU", () => {
    expect(() =>
      normalizeNuvemshopVariant(
        {
          productId: 10,
          variantId: 20,
          name: "Camiseta",
          sku: " ",
          price: "49.90",
          cost: "20.00",
          stockManagement: true,
          attributes: [],
          inventoryLevels: [],
        },
        "physical",
      ),
    ).toThrow();
  });
});
