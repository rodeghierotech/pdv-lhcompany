import { describe, expect, it } from "vitest";
import { catalogFeedback } from "./catalog-view-model";

describe("catalogFeedback", () => {
  it("never describes a pending import as confirmed", () => {
    expect(catalogFeedback("pending")).toEqual({ title: "Importação pendente", confirmed: false });
  });
});
