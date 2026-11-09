import { describe, expect, it } from "vitest";

import { toReplenishmentRequest } from "./replenishment-form";

describe("toReplenishmentRequest", () => {
  it("requires a positive quantity and converts cost to cents", () => {
    expect(toReplenishmentRequest({ quantity: "4", unitCost: "12,50", sourceReference: "NF 21" }, "e30ed00e-61a6-4685-8b3b-35f0fd65c65e", "a30ed00e-61a6-4685-8b3b-35f0fd65c65e")).toMatchObject({
      quantity: 4,
      unitCostInCents: 1250,
      sourceReference: "NF 21",
    });
  });

  it("rejects zero quantity", () => {
    expect(() => toReplenishmentRequest({ quantity: "0", unitCost: "12,50", sourceReference: "" }, "e30ed00e-61a6-4685-8b3b-35f0fd65c65e", "a30ed00e-61a6-4685-8b3b-35f0fd65c65e")).toThrow();
  });
});
