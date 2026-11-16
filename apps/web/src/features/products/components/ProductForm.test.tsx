import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CreateProductCommand, Product } from "@lh-company/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../../App";
import { ApiError } from "../../../lib/api-client";
import { createProduct } from "../api/products-api";
import { ProductForm } from "./ProductForm";

const operationId = "b5622aa1-81ab-432e-b6d2-bd6955ca1842";
const command: CreateProductCommand = {
  operationId,
  product: { name: "Camisa", description: null, category: null, active: true, variants: [{
    sku: "CAM-AZ-M", barcode: null, attributes: [], salePriceInCents: 18990, costInCents: 8000,
    minimumStockQuantity: 3, tracksInventory: true, active: true,
  }] },
};
const product: Product = { ...command.product, id: "b5622aa1-81ab-432e-b6d2-bd6955ca1843", variants: command.product.variants.map((variant) => ({ ...variant, id: "b5622aa1-81ab-432e-b6d2-bd6955ca1844", productId: "b5622aa1-81ab-432e-b6d2-bd6955ca1843" })) };

afterEach(() => vi.unstubAllGlobals());

function change(label: string | RegExp, value: string, root: Pick<typeof screen, "getByLabelText"> = screen) {
  fireEvent.change(root.getByLabelText(label), { target: { value } });
}
function variant(index = 1) { return within(screen.getByRole("group", { name: `Variante ${index}` })); }
function fillValid() {
  change("Nome do produto", "Camisa");
  change("SKU", "CAM-AZ-M", variant());
  change("Preço de venda (R$)", "189,90", variant());
  change("Custo (R$)", "80,00", variant());
}
function setup(onSubmit = vi.fn<(input: CreateProductCommand) => Promise<void>>().mockResolvedValue(undefined)) {
  const onCancel = vi.fn();
  const operationIdFactory = vi.fn(() => operationId);
  const view = render(<ProductForm onSubmit={onSubmit} onCancel={onCancel} operationIdFactory={operationIdFactory} />);
  return { onSubmit, onCancel, operationIdFactory, ...view };
}
function save() { fireEvent.click(screen.getByRole("button", { name: "Salvar produto" })); }
function values(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLInputElement>("input")).map((input) => [input.value, input.checked]);
}

describe("product and variants registration", () => {
  it("starts with one required variant and default minimum 3, and submits one aggregate in cents", async () => {
    const { onSubmit } = setup();
    expect(screen.getAllByRole("group", { name: /^Variante \d/ })).toHaveLength(1);
    expect(variant().getByLabelText("Estoque mínimo")).toHaveValue("3");
    expect(variant().getByRole("button", { name: /remover variante/i })).toBeDisabled();
    fillValid();
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledExactlyOnceWith(command));
  });

  it("adds/removes variants without losing the other variant's fields", () => {
    setup();
    fillValid();
    fireEvent.click(screen.getByRole("button", { name: "Adicionar variante" }));
    change("SKU", "CAM-G", variant(2));
    fireEvent.click(variant().getByRole("button", { name: "Remover variante" }));
    expect(screen.getAllByRole("group", { name: /^Variante \d/ })).toHaveLength(1);
    expect(variant().getByLabelText("SKU")).toHaveValue("CAM-G");
    expect(variant().getByLabelText("Estoque mínimo")).toHaveValue("3");
  });

  it("offers Cor/Tamanho once per variant and accepts custom attributes", async () => {
    const { onSubmit } = setup();
    fillValid();
    const first = variant();
    fireEvent.click(first.getByRole("button", { name: "Adicionar Cor/Tamanho" }));
    fireEvent.click(first.getByRole("button", { name: "Adicionar Cor/Tamanho" }));
    expect(first.getAllByLabelText(/Nome do atributo/)).toHaveLength(2);
    change("Valor do atributo 1", "Azul", first);
    change("Valor do atributo 2", "M", first);
    fireEvent.click(first.getByRole("button", { name: "Adicionar atributo" }));
    change("Nome do atributo 3", "Tecido", first);
    change("Valor do atributo 3", "Linho", first);
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0].product.variants[0]?.attributes).toEqual([
      { name: "Cor", value: "Azul" }, { name: "Tamanho", value: "M" }, { name: "Tecido", value: "Linho" },
    ]);
  });

  it("removes an optional attribute without removing the variant", () => {
    setup();
    fireEvent.click(variant().getByRole("button", { name: "Adicionar Cor/Tamanho" }));
    fireEvent.click(variant().getByRole("button", { name: "Remover atributo 1" }));
    expect(variant().getAllByLabelText(/Nome do atributo/)).toHaveLength(1);
    expect(variant().getByLabelText("Nome do atributo 1")).toHaveValue("Tamanho");
  });

  it("shows each field error and focuses the first invalid field in document order", async () => {
    const { onSubmit } = setup();
    save();
    const name = screen.getByLabelText("Nome do produto");
    await waitFor(() => expect(name).toHaveFocus());
    expect(name).toHaveAccessibleDescription(/informe o nome/i);
    expect(variant().getByLabelText("SKU")).toHaveAttribute("aria-invalid", "true");
    expect(onSubmit).not.toHaveBeenCalled();
    fillValid();
    fireEvent.click(screen.getByRole("button", { name: "Adicionar variante" }));
    change("Preço de venda (R$)", "1.23", variant(2));
    save();
    await waitFor(() => expect(variant(2).getByLabelText("SKU")).toHaveFocus());
    expect(variant(2).getByLabelText("Preço de venda (R$)")).toHaveAttribute("aria-invalid", "true");
    expect(variant().getByLabelText("SKU")).not.toHaveAttribute("aria-invalid", "true");
  });

  it("rejects fractional minimum stock and points to that exact field", async () => {
    const { onSubmit } = setup();
    fillValid();
    change("Estoque mínimo", "1,5", variant());
    save();
    await waitFor(() => expect(variant().getByLabelText("Estoque mínimo")).toHaveFocus());
    expect(variant().getByLabelText("Estoque mínimo")).toHaveAccessibleDescription(/inteiro/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("validates attributes at their precise variant and attribute index", async () => {
    const { onSubmit } = setup();
    fillValid();
    fireEvent.click(variant().getByRole("button", { name: "Adicionar Cor/Tamanho" }));
    change("Valor do atributo 1", "Azul", variant());
    save();
    await waitFor(() => expect(variant().getByLabelText("Valor do atributo 2")).toHaveFocus());
    expect(variant().getByLabelText("Valor do atributo 1")).not.toHaveAttribute("aria-invalid", "true");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("locks pending submission against double click, Enter and edits", async () => {
    let resolve!: () => void;
    const { onSubmit } = setup(vi.fn(() => new Promise<void>((done) => { resolve = done; })));
    fillValid();
    save();
    fireEvent.submit(screen.getByRole("form", { name: "Cadastro de produto" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /salvar produto/i })).toBeDisabled();
    expect(screen.getByLabelText("Nome do produto")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    await act(async () => resolve());
    expect(screen.getByRole("button", { name: "Salvar produto" })).toBeDisabled();
  });

  it.each([
    new ApiError(0, "NETWORK_ERROR", "Falha de rede."),
    new ApiError(409, "PRODUCT_CONFLICT", "Confira o SKU ou código de barras."),
  ])("preserves every field and operationId after $code, including edits before retry", async (error) => {
    const onSubmit = vi.fn<(input: CreateProductCommand) => Promise<void>>().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const { container, operationIdFactory } = setup(onSubmit);
    fillValid();
    change("Descrição", "Coleção verão");
    change("Categoria", "Camisas");
    fireEvent.click(screen.getByLabelText("Produto ativo"));
    fireEvent.click(variant().getByLabelText("Controlar estoque"));
    fireEvent.click(variant().getByLabelText("Variante ativa"));
    change("Código de barras", "789001", variant());
    change("Estoque mínimo", "9", variant());
    fireEvent.click(variant().getByRole("button", { name: "Adicionar Cor/Tamanho" }));
    change("Valor do atributo 1", "Azul", variant());
    change("Valor do atributo 2", "M", variant());
    fireEvent.click(screen.getByRole("button", { name: "Adicionar variante" }));
    change("SKU", "CAM-BR-G", variant(2));
    change("Código de barras", "789002", variant(2));
    change("Preço de venda (R$)", "199,90", variant(2));
    change("Custo (R$)", "82,01", variant(2));
    fireEvent.click(variant(2).getByRole("button", { name: "Adicionar atributo" }));
    change("Nome do atributo 1", "Tecido", variant(2));
    change("Valor do atributo 1", "Linho", variant(2));
    const before = values(container);
    save();
    await screen.findByRole("alert");
    expect(values(container)).toEqual(before);
    expect(screen.queryByText(/confirmado no servidor/i)).not.toBeInTheDocument();
    change("Nome do produto", "Camisa de linho");
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls.map(([input]) => input.operationId)).toEqual([operationId, operationId]);
    expect(onSubmit.mock.calls[1]?.[0].product.name).toBe("Camisa de linho");
    expect(operationIdFactory).toHaveBeenCalledOnce();
  });

  it("keeps a payload conflict unresolved until explicit catalog reconciliation", async () => {
    const onSubmit = vi.fn<(input: CreateProductCommand) => Promise<void>>().mockRejectedValue(new ApiError(409, "OPERATION_PAYLOAD_CONFLICT", "Dados diferentes."));
    const { container, onCancel, operationIdFactory } = setup(onSubmit);
    fillValid();
    const before = values(container);
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(/possivelmente confirmado|pode ter sido confirmado/i);
    expect(values(container)).toEqual(before);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Salvar produto" })).toBeDisabled();
    expect(operationIdFactory).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Voltar ao catálogo e atualizar" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("cancels only on explicit user action", () => {
    const { onCancel, onSubmit } = setup();
    fillValid();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("create product API and catalog integration", () => {
  it("posts product and variants in one validated request and validates the response", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(product, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    expect(await createProduct(command)).toEqual(product);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/products");
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(command);
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("blocks invalid command and unsafe response without exposing inputs", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...product, variants: [] }, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    await expect(createProduct({ ...command, operationId: "invalid" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(createProduct(command)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("returns to a refreshed catalog and announces success only after server creation", async () => {
    let confirm!: (response: Response) => void;
    const fetch = vi.fn().mockResolvedValueOnce(Response.json([]))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { confirm = resolve; }))
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    await screen.findByText(/nenhuma variante/i);
    fireEvent.click(screen.getByRole("button", { name: /novo produto/i }));
    fillValid();
    save();
    expect(screen.getByRole("heading", { name: "Novo produto" })).toBeInTheDocument();
    expect(screen.queryByText(/confirmado no servidor/i)).not.toBeInTheDocument();
    await act(async () => confirm(Response.json(product, { status: 201 })));
    expect(await screen.findByRole("heading", { name: "Produtos e estoque" })).toBeInTheDocument();
    expect(screen.getByText(/produto e variantes confirmados no servidor/i)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[2]?.[0])).toContain("/api/products?");
  });

  it.each(["NETWORK_ERROR", "PRODUCT_CONFLICT", "OPERATION_PAYLOAD_CONFLICT"])("stays on the form without false success on %s", async (code) => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json([]));
    if (code === "NETWORK_ERROR") fetch.mockRejectedValueOnce(new Error("secret"));
    else fetch.mockResolvedValueOnce(Response.json({ code }, { status: 409 }));
    fetch.mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    await screen.findByText(/nenhuma variante/i);
    fireEvent.click(screen.getByRole("button", { name: /novo produto/i }));
    fillValid();
    save();
    await screen.findByRole("alert");
    expect(screen.getByRole("heading", { name: "Novo produto" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nome do produto")).toHaveValue("Camisa");
    expect(screen.queryByText(/produto e variantes confirmados/i)).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    if (code === "OPERATION_PAYLOAD_CONFLICT") {
      fireEvent.click(screen.getByRole("button", { name: "Voltar ao catálogo e atualizar" }));
      await screen.findByRole("heading", { name: "Produtos e estoque" });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(screen.queryByText(/produto e variantes confirmados/i)).not.toBeInTheDocument();
    }
  });
});
