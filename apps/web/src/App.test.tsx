import type { InventoryHistoryResponse, ProductCatalogItem } from "@lh-company/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App";

const variant: ProductCatalogItem = {
  productId: "fdf19de1-a235-4cdc-9b6d-e01df6bc1e22", productName: "Camisa", productActive: true,
  variantId: "fdf19de1-a235-4cdc-9b6d-e01df6bc1e23", sku: "CAM-M", barcode: null,
  attributes: [], salePriceInCents: 3000, costInCents: 1000, quantity: 2, minimumStockQuantity: 3,
  tracksInventory: true, variantActive: true,
};
const history: InventoryHistoryResponse = {
  variantId: variant.variantId, productId: variant.productId, productName: variant.productName,
  sku: variant.sku, attributes: [], quantity: 2, costInCents: 1000, estimatedStockCostInCents: 2000, movements: [],
};

afterEach(() => vi.unstubAllGlobals());

it("returns from product creation to the catalog through Products navigation", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(Response.json([]))));
  render(<App />);
  await screen.findByText(/nenhuma variante encontrada/i);
  fireEvent.click(screen.getByRole("button", { name: "Novo produto" }));
  expect(screen.getByRole("form", { name: "Cadastro de produto" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Produtos" }));
  expect(await screen.findByRole("heading", { name: "Produtos e estoque" })).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "Cadastro de produto" })).not.toBeInTheDocument();
});

it("returns from variant inventory to the catalog through the Products keyboard shortcut", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) =>
    Promise.resolve(Response.json(url.includes("/history") ? history : [variant]))));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Camisa.*Sem atributos/ }));
  await screen.findByRole("heading", { name: "Dados comerciais do estoque" });
  fireEvent.keyDown(document.body, { key: "p", altKey: true });
  expect(await screen.findByRole("heading", { name: "Produtos e estoque" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Detalhe do estoque da variante" })).not.toBeInTheDocument();
});
