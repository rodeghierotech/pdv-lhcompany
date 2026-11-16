import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CreateReplenishmentCommand, InventoryHistoryResponse, ProductCatalogItem } from "@lh-company/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../../App";
import { ApiError } from "../../../lib/api-client";
import { getInventoryHistory, replenishInventory } from "../api/inventory-api";
import { ReplenishmentForm } from "./ReplenishmentForm";

const operationId = "b5622aa1-81ab-432e-b6d2-bd6955ca1842";
const history: InventoryHistoryResponse = {
  variantId: "b5622aa1-81ab-432e-b6d2-bd6955ca1844", productId: "b5622aa1-81ab-432e-b6d2-bd6955ca1843",
  productName: "Camisa", sku: "CAM-AZ-M", attributes: [{ name: "Cor", value: "Azul" }], quantity: 2,
  costInCents: 8000, estimatedStockCostInCents: 16000, movements: [],
};
const catalog: ProductCatalogItem = { ...history, productActive: true, variantActive: true, barcode: null,
  salePriceInCents: 18990, minimumStockQuantity: 3, tracksInventory: true };
const command: CreateReplenishmentCommand = { operationId, variantId: history.variantId, quantity: 3, unitCostInCents: 123456, sourceReference: "NF 123" };
afterEach(() => vi.unstubAllGlobals());
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function fill() { change("Quantidade de entrada", "3"); change("Custo unitário (R$)", "1.234,56"); change("Referência ou lote do fornecedor", "  NF 123  "); }
function review() { fireEvent.click(screen.getByRole("button", { name: "Conferir entrada" })); }
function confirm() { fireEvent.click(screen.getByRole("button", { name: /^Registrar entrada auditável/ })); }
function setup(onSubmit = vi.fn<(input: CreateReplenishmentCommand) => Promise<void>>().mockResolvedValue(undefined)) {
  const onCancel = vi.fn();
  const operationIdFactory = vi.fn(() => operationId);
  render(<ReplenishmentForm variant={history} currentQuantity={2} onSubmit={onSubmit} onCancel={onCancel} operationIdFactory={operationIdFactory} />);
  return { onSubmit, onCancel, operationIdFactory };
}

describe("replenishment form", () => {
  it.each(["", "0", "-1", "1,5", "1.5", "1e2", "9007199254740992"])("blocks non-positive/non-whole/unsafe quantity %s and focuses the field", async (value) => {
    const { onSubmit } = setup(); fill(); change("Quantidade de entrada", value); review();
    await waitFor(() => expect(screen.getByLabelText("Quantidade de entrada")).toHaveFocus());
    expect(screen.getByLabelText("Quantidade de entrada")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("button", { name: "Registrar entrada auditável" })).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it.each(["", "-1,00", "1.23", "0,001", "R$ 1,00"])("blocks invalid monetary cost %s", (value) => {
    setup(); fill(); change("Custo unitário (R$)", value); review();
    expect(screen.getByLabelText("Custo unitário (R$)")).toHaveAttribute("aria-invalid", "true");
  });
  it("rejects overlong references and totals/projections above the safe integer limit", () => {
    setup(); fill(); change("Referência ou lote do fornecedor", "A".repeat(201)); review();
    expect(screen.getByLabelText("Referência ou lote do fornecedor")).toHaveAttribute("aria-invalid", "true");
    change("Referência ou lote do fornecedor", "NF 123"); change("Custo unitário (R$)", "90.071.992.547.409,91"); review();
    expect(screen.getByLabelText("Custo unitário (R$)")).toHaveAccessibleDescription(/total.*limite/i);
    change("Custo unitário (R$)", "0"); change("Quantidade de entrada", "9007199254740991"); review();
    expect(screen.getByLabelText("Quantidade de entrada")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("button", { name: "Registrar entrada auditável" })).not.toBeInTheDocument();
  });
  it("shows projection and complete confirmation before sending exact cents without client time", async () => {
    const { onSubmit } = setup(); fill(); review();
    const summary = screen.getByRole("region", { name: "Conferência da entrada" });
    expect(screen.getByRole("heading", { name: "Conferência da entrada" })).toHaveFocus();
    expect(summary).toHaveTextContent("CAM-AZ-M"); expect(summary).toHaveTextContent("Cor: Azul");
    expect(summary).toHaveTextContent("+3 un."); expect(summary).toHaveTextContent("1.234,56");
    expect(summary).toHaveTextContent("3.703,68"); expect(summary).toHaveTextContent("5 un.");
    expect(summary).toHaveTextContent("NF 123"); expect(onSubmit).not.toHaveBeenCalled();
    confirm(); await waitFor(() => expect(onSubmit).toHaveBeenCalledExactlyOnceWith(command));
    expect(Object.keys(onSubmit.mock.calls[0]![0]).sort()).toEqual(["operationId", "quantity", "sourceReference", "unitCostInCents", "variantId"]);
  });
  it("requires renewed review after editing and allows zero cost and omitted reference", async () => {
    const { onSubmit } = setup(); fill(); review();
    fireEvent.click(screen.getByRole("button", { name: "Revisar campos" }));
    expect(screen.getByLabelText("Quantidade de entrada")).toHaveFocus();
    change("Custo unitário (R$)", "0"); change("Referência ou lote do fornecedor", "");
    expect(screen.queryByRole("button", { name: "Registrar entrada auditável" })).not.toBeInTheDocument();
    review(); confirm(); await waitFor(() => expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ operationId, variantId: history.variantId, quantity: 3, unitCostInCents: 0 }));
  });
  it("blocks double submit, editing and cancel while awaiting server confirmation, and resubmit after success", async () => {
    let resolve!: () => void;
    const { onSubmit, onCancel } = setup(vi.fn(() => new Promise<void>((done) => { resolve = done; })));
    fill(); review(); confirm(); confirm();
    fireEvent.submit(screen.getByRole("form", { name: "Reposição de estoque" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    expect(screen.getByLabelText("Quantidade de entrada")).toBeDisabled();
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => resolve());
    fireEvent.submit(screen.getByRole("form", { name: "Reposição de estoque" }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
  it("preserves all fields and operationId for identical recoverable retry", async () => {
    const onSubmit = vi.fn<(input: CreateReplenishmentCommand) => Promise<void>>().mockRejectedValueOnce(new Error("secret")).mockResolvedValueOnce(undefined);
    const { operationIdFactory } = setup(onSubmit); fill(); review(); confirm();
    expect(await screen.findByRole("alert")).toHaveTextContent(/preservados/i);
    expect(screen.getByLabelText("Quantidade de entrada")).toHaveValue("3");
    expect(screen.getByLabelText("Custo unitário (R$)")).toHaveValue("1.234,56");
    expect(screen.getByLabelText("Referência ou lote do fornecedor")).toHaveValue("  NF 123  ");
    confirm(); await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls.map(([input]) => input)).toEqual([command, command]);
    expect(operationIdFactory).toHaveBeenCalledOnce();
  });
  it("blocks payload conflict and offers explicit server reconciliation without replacing the ID", async () => {
    const { onSubmit, onCancel, operationIdFactory } = setup(vi.fn().mockRejectedValue(new ApiError(409, "OPERATION_PAYLOAD_CONFLICT", "conflict")));
    fill(); review(); confirm();
    expect(await screen.findByRole("alert")).toHaveTextContent(/confira/i);
    expect(screen.getByRole("button", { name: "Registrar entrada auditável" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Voltar e consultar o servidor" }));
    expect(onCancel).toHaveBeenCalledOnce(); expect(onSubmit).toHaveBeenCalledOnce(); expect(operationIdFactory).toHaveBeenCalledOnce();
  });
  it("preserves fields and identity after a 409 and lets the user revise before retry", async () => {
    const onSubmit = vi.fn<(input: CreateReplenishmentCommand) => Promise<void>>().mockRejectedValueOnce(new ApiError(409, "INVENTORY_OPERATION_NOT_ALLOWED", "Confira a situação da variante.")).mockResolvedValueOnce(undefined);
    const { operationIdFactory } = setup(onSubmit); fill(); review(); confirm();
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Referência ou lote do fornecedor")).toHaveValue("  NF 123  ");
    fireEvent.click(screen.getByRole("button", { name: "Revisar campos" })); change("Quantidade de entrada", "4"); review(); confirm();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1]?.[0]).toEqual({ ...command, quantity: 4 }); expect(operationIdFactory).toHaveBeenCalledOnce();
  });
});

describe("inventory API boundary", () => {
  it("uses the inventory routes and validates request/response", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json(history)));
    vi.stubGlobal("fetch", fetch);
    expect(await replenishInventory(command)).toEqual(history);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/inventory/replenishments");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify(command) });
    expect(await getInventoryHistory(history.variantId)).toEqual(history);
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/inventory/variants/${history.variantId}/history`);
    await expect(replenishInventory({ ...command, quantity: 0 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(getInventoryHistory("invalid/id")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["get", "post"])("rejects malformed %s responses safely", async (method) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...history, quantity: "postgres://secret" })));
    const result = method === "get" ? getInventoryHistory(history.variantId) : replenishInventory(command);
    await expect(result).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(result).rejects.not.toThrow(/postgres|secret/);
  });
});

describe("variant inventory workflow", () => {
  it("opens from catalog and updates stock, average cost, estimated cost and history only after success", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn().mockResolvedValueOnce(Response.json([catalog])).mockResolvedValueOnce(Response.json(history))
      .mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; })).mockResolvedValueOnce(Response.json([catalog]));
    vi.stubGlobal("fetch", fetch); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Camisa.*Cor: Azul/ }));
    const stock = await screen.findByRole("region", { name: "Dados comerciais do estoque" });
    expect(stock).toHaveTextContent("2 un."); expect(stock).toHaveTextContent("80,00"); expect(stock).toHaveTextContent("160,00");
    expect(screen.getByRole("region", { name: "Estado no servidor" })).toHaveTextContent("Confirmado no servidor");
    fireEvent.click(screen.getByRole("button", { name: "Registrar reposição" })); fill(); review(); confirm();
    expect(stock).toHaveTextContent("2 un."); expect(stock).not.toHaveTextContent("5 un.");
    expect(screen.getByRole("region", { name: "Estado no servidor" })).toHaveTextContent(/aguardando/i);
    expect(screen.queryByText(/entrada confirmada/i)).not.toBeInTheDocument();
    await act(async () => resolve(Response.json({ ...history, quantity: 5, costInCents: 77207, estimatedStockCostInCents: 386035, movements: [{
      id: operationId, variantId: history.variantId, reason: "replenishment", quantityDelta: 3, occurredAt: "2026-11-14T12:00:00Z",
      referenceId: null, lotId: null, operationId, sourceReference: "NF 123",
    }] })));
    expect(stock).toHaveTextContent("5 un."); expect(stock).toHaveTextContent("772,07"); expect(stock).toHaveTextContent("3.860,35");
    expect(screen.getByText(/entrada confirmada/i)).toBeInTheDocument(); expect(screen.getByText("+3 un.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Camisa" })).toHaveFocus();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Voltar ao catálogo" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  });
  it("shows query error without false confirmation and retries the server", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json([catalog])).mockRejectedValueOnce(new Error("secret"))
      .mockResolvedValueOnce(Response.json(history));
    vi.stubGlobal("fetch", fetch); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Camisa.*Cor: Azul/ }));
    expect(await screen.findByRole("alert")).not.toHaveTextContent("secret");
    expect(screen.queryByText("Confirmado no servidor")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Registrar reposição" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByRole("region", { name: "Dados comerciais do estoque" })).toHaveTextContent("2 un.");
  });
  it("keeps the prior snapshot and fields after a failed entry without reporting successful confirmation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json([catalog])).mockResolvedValueOnce(Response.json(history))
      .mockRejectedValueOnce(new Error("offline")));
    render(<App />); fireEvent.click(await screen.findByRole("button", { name: /Camisa.*Cor: Azul/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Registrar reposição" })); fill(); review(); confirm();
    await screen.findByRole("alert");
    expect(screen.getByRole("region", { name: "Dados comerciais do estoque" })).toHaveTextContent("2 un.");
    const server = within(screen.getByRole("region", { name: "Estado no servidor" }));
    expect(server.getByText(/reposição sem confirmação/i)).toBeInTheDocument();
    expect(screen.queryByText(/entrada confirmada/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Quantidade de entrada")).toHaveValue("3");
  });
});
