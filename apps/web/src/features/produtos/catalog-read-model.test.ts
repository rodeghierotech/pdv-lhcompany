import { describe, expect, it } from "vitest";

import { toCatalogRows } from "./catalog-read-model";

describe("toCatalogRows", () => {
  it("keeps server-confirmed stock separate from a missing balance", () => {
    expect(toCatalogRows([{
      id: "variant-1",
      sku: "CAM-P",
      sale_price_in_cents: 4990,
      requires_cost_review: true,
      product: { name: "Camiseta" },
      inventory_balance: { quantity: 3 },
    }])).toEqual([{
      id: "variant-1",
      sku: "CAM-P",
      name: "Camiseta",
      salePriceInCents: 4990,
      quantity: 3,
      requiresCostReview: true,
    }]);
  });
});
