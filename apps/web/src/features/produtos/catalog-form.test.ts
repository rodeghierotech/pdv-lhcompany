import { describe, expect, it } from "vitest";

import { toCents, toManualCatalogRequest } from "./catalog-form";

describe("catalog form", () => {
  it("converts Brazilian decimal values to integer cents", () => {
    expect(toCents("49,90")).toBe(4990);
  });

  it("keeps a missing cost visible as a review requirement", () => {
    expect(
      toManualCatalogRequest({
        name: "Camiseta básica",
        sku: "CAM-001-P",
        salePrice: "49,90",
        cost: "",
        initialQuantity: "3",
      }, "e30ed00e-61a6-4685-8b3b-35f0fd65c65e"),
    ).toMatchObject({ costInCents: 0, initialQuantity: 3 });
  });
});
