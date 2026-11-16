import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ProductCatalogItem } from "@lh-company/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listProducts } from "../api/products-api";
import { ProductCatalogPage } from "../pages/ProductCatalogPage";

const variant: ProductCatalogItem = {
  productId: "fdf19de1-a235-4cdc-9b6d-e01df6bc1e22", productName: "Camisa de linho", productActive: true,
  variantId: "fdf19de1-a235-4cdc-9b6d-e01df6bc1e23", sku: "LINHO-AZ-M", barcode: null,
  attributes: [{ name: "Cor", value: "Azul" }, { name: "Tamanho", value: "M" }],
  salePriceInCents: 12990, costInCents: 6000, quantity: 2, minimumStockQuantity: 3,
  tracksInventory: true, variantActive: true,
};
const secondVariant: ProductCatalogItem = { ...variant, variantId: "fdf19de1-a235-4cdc-9b6d-e01df6bc1e24", sku: "LINHO-AZ-G", quantity: 8, attributes: [{ name: "Cor", value: "Azul" }, { name: "Tamanho", value: "G" }] };

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function renderPage() {
  const onCreateProduct = vi.fn();
  const onSelectVariant = vi.fn();
  render(<ProductCatalogPage onCreateProduct={onCreateProduct} onSelectVariant={onSelectVariant} />);
  return { onCreateProduct, onSelectVariant };
}

describe("product catalog", () => {
  it("shows loading without presenting unconfirmed balances", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderPage();
    expect(screen.getByRole("status")).toHaveTextContent(/carregando/i);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/dados consultados no servidor/i)).not.toBeInTheDocument();
  });

  it("offers creation when no variants match", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([])));
    const { onCreateProduct } = renderPage();
    expect(await screen.findByText(/nenhuma variante encontrada/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /novo produto/i }));
    expect(onCreateProduct).toHaveBeenCalledOnce();
  });

  it.each([409, 500, 0])("keeps failed queries unconfirmed and allows retry (status %s)", async (status) => {
    const fetch = vi.fn();
    if (status) fetch.mockResolvedValueOnce(Response.json({ code: "PRODUCT_CONFLICT", message: "postgres://secret" }, { status }));
    else fetch.mockRejectedValueOnce(new Error("postgres://secret"));
    fetch.mockResolvedValueOnce(Response.json([variant]));
    vi.stubGlobal("fetch", fetch);
    renderPage();
    const error = await screen.findByRole("alert");
    expect(error).not.toHaveTextContent(/postgres|secret/);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/dados consultados no servidor/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /tentar novamente/i }));
    expect(await screen.findByText("LINHO-AZ-M")).toBeInTheDocument();
  });

  it("sends trimmed, debounced search to the server and preserves the typed input", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json([])));
    vi.stubGlobal("fetch", fetch);
    renderPage();
    await act(async () => {});
    fireEvent.change(screen.getByRole("textbox", { name: /buscar/i }), { target: { value: "  linho azul  " } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/products?search=linho+azul&lowStockOnly=false&status=active&limit=50");
    expect(screen.getByRole("textbox", { name: /buscar/i })).toHaveValue("  linho azul  ");
  });

  it("queries the server immediately for low stock and status filters", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json([])));
    vi.stubGlobal("fetch", fetch);
    renderPage();
    await screen.findByText(/nenhuma variante/i);
    fireEvent.click(screen.getByRole("button", { name: "Estoque baixo" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[1]?.[0]).toContain("lowStockOnly=true&status=active");
    fireEvent.click(screen.getByRole("button", { name: "Inativos" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls[2]?.[0]).toContain("lowStockOnly=false&status=inactive");
    fireEvent.click(screen.getByRole("button", { name: "Todos" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(fetch.mock.calls[3]?.[0]).toContain("status=all");
  });

  it("renders one responsive row per variant, with server stock, attributes, price and reconciliation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([variant, secondVariant])));
    const { onSelectVariant } = renderPage();
    const table = await screen.findByRole("table", { name: "Variantes do catálogo" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(screen.getAllByText("LINHO-AZ-M")).toHaveLength(1);
    expect(screen.getAllByText("LINHO-AZ-G")).toHaveLength(1);
    expect(within(table).getAllByText(/estoque baixo/i)).toHaveLength(1);
    expect(within(table).getByRole("button", { name: /Camisa de linho.*Tamanho: M/ })).toHaveTextContent("Cor: Azul");
    expect(within(table).getAllByText(/129,90/)).toHaveLength(2);
    expect(screen.getByText(/1 produto.*2 variantes.*nesta consulta/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Conferência desta consulta")).toHaveTextContent(/custo em estoque:.*600,00/i);
    expect(screen.getByText(/dados consultados no servidor/i)).toBeInTheDocument();
    fireEvent.click(within(table).getByRole("button", { name: /Camisa de linho.*Tamanho: M/ }));
    expect(onSelectVariant).toHaveBeenCalledExactlyOnceWith(variant.variantId);
  });

  it("discards stale results after a newer filter query completes", async () => {
    let resolveFirst!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(Response.json([secondVariant]));
    vi.stubGlobal("fetch", fetch);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Inativos" }));
    await screen.findByText("LINHO-AZ-G");
    await act(async () => { resolveFirst(Response.json([variant])); });
    expect(screen.queryByText("LINHO-AZ-M")).not.toBeInTheDocument();
    expect(screen.getByText("LINHO-AZ-G")).toBeInTheDocument();
  });

  it("removes previous balances and confirmation while a new query is pending or fails", async () => {
    let fail!: (error: Error) => void;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json([variant]))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; })));
    renderPage();
    await screen.findByText("LINHO-AZ-M");
    fireEvent.click(screen.getByRole("button", { name: "Estoque baixo" }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/dados consultados no servidor/i)).not.toBeInTheDocument();
    await act(async () => { fail(new Error("offline")); });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("LINHO-AZ-M")).not.toBeInTheDocument();
  });

  it("rejects invalid catalog payloads without leaking validation inputs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([{ ...variant, quantity: "postgres://secret" }])));
    renderPage();
    expect(await screen.findByRole("alert")).not.toHaveTextContent(/postgres|secret/);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("products API boundary", () => {
  it("normalizes query input and validates the response with shared contracts", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json([variant]));
    vi.stubGlobal("fetch", fetch);
    const result = await listProducts({ search: "  LINHO  ", lowStockOnly: true, status: "all", limit: 500 });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/products?search=LINHO&lowStockOnly=true&status=all&limit=100");
    expect(result[0]?.variantId).toBe(variant.variantId);
  });
});
