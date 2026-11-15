import assert from "node:assert/strict";
import { test } from "node:test";
import * as contracts from "./products.js";

const operationId = "a8d17203-3527-442c-824b-bbc59ad41a5b";
const product = {
  name: "Camiseta",
  description: null,
  category: null,
  active: true,
  variants: [{
    sku: "CAM-M",
    barcode: null,
    attributes: [{ name: "Tamanho", value: "M" }],
    salePriceInCents: 5_000,
    costInCents: 2_000,
    tracksInventory: true,
    active: true,
  }],
};

test("applies_default_minimum_stock_of_three", () => {
  const result = contracts.CreateProductCommandSchema.parse({ operationId, product });
  assert.equal(result.product.variants[0]?.minimumStockQuantity, 3);
});

test("rejects_negative_minimum_stock", () => {
  const result = contracts.CreateProductCommandSchema.safeParse({
    operationId,
    product: { ...product, variants: [{ ...product.variants[0], minimumStockQuantity: -1 }] },
  });
  assert.equal(result.success, false);
});

test("rejects_product_without_variants", () => {
  assert.equal(contracts.CreateProductCommandSchema.safeParse({
    operationId, product: { ...product, variants: [] },
  }).success, false);
});

test("rejects_fractional_money_in_cents", () => {
  for (const field of ["salePriceInCents", "costInCents"]) {
    assert.equal(contracts.CreateProductCommandSchema.safeParse({
      operationId,
      product: { ...product, variants: [{ ...product.variants[0], [field]: 10.5 }] },
    }).success, false, field);
  }
});

test("trims_catalog_search", () => {
  assert.equal(contracts.ProductCatalogQuerySchema.parse({ search: "  CAM-M  " }).search, "CAM-M");
});

test("defaults_catalog_status_to_active", () => {
  assert.deepEqual(contracts.ProductCatalogQuerySchema.parse({}), {
    search: "", lowStockOnly: false, status: "active", limit: 50,
  });
});

test("caps_catalog_limit", () => {
  assert.equal(contracts.ProductCatalogQuerySchema.parse({ limit: "500" }).limit, 100);
  assert.equal(contracts.ProductCatalogQuerySchema.parse({ limit: 25 }).limit, 25);
});

test("parses_http_catalog_filters_without_treating_false_as_true", () => {
  assert.equal(contracts.ProductCatalogQuerySchema.parse({ lowStockOnly: "false" }).lowStockOnly, false);
  assert.equal(contracts.ProductCatalogQuerySchema.parse({ lowStockOnly: "true", status: "inactive" }).lowStockOnly, true);
  assert.equal(contracts.ProductCatalogQuerySchema.parse({ status: "all" }).status, "all");
});

test("rejects_invalid_catalog_filters", () => {
  for (const query of [{ limit: 0 }, { limit: 1.5 }, { limit: "invalid" }, { status: "deleted" }, { lowStockOnly: "invalid" }]) {
    assert.equal(contracts.ProductCatalogQuerySchema.safeParse(query).success, false);
  }
});

test("parses_catalog_item_with_signed_balance_and_separate_active_flags", () => {
  const result = contracts.ProductCatalogItemSchema.parse({
    productId: operationId,
    productName: "Camiseta",
    productActive: false,
    variantId: "6c115211-6b97-4b98-ae6e-7157ab973c50",
    sku: "CAM-M",
    barcode: null,
    attributes: [{ name: "Tamanho", value: "M" }],
    salePriceInCents: 5_000,
    costInCents: 2_000,
    quantity: -1,
    minimumStockQuantity: 3,
    tracksInventory: true,
    variantActive: true,
  });
  assert.equal(result.quantity, -1);
  assert.equal(result.productActive, false);
  assert.equal(result.variantActive, true);
});
