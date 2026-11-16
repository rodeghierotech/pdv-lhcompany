import { render, screen, within } from "@testing-library/react";
import type { InventoryHistoryResponse, InventoryMovementReason } from "@lh-company/contracts";
import { describe, expect, it } from "vitest";
import { InventoryHistory } from "./InventoryHistory";

const history: InventoryHistoryResponse = {
  variantId: "b5622aa1-81ab-432e-b6d2-bd6955ca1844", productId: "b5622aa1-81ab-432e-b6d2-bd6955ca1843",
  productName: "Camisa", sku: "CAM-AZ-M", attributes: [], quantity: 2, costInCents: 8000, estimatedStockCostInCents: 16000,
  movements: [{ id: "b5622aa1-81ab-432e-b6d2-bd6955ca1842", variantId: "b5622aa1-81ab-432e-b6d2-bd6955ca1844", reason: "replenishment",
    quantityDelta: 5, occurredAt: "2026-11-13T12:00:00Z", referenceId: "b5622aa1-81ab-432e-b6d2-bd6955ca1848", lotId: "b5622aa1-81ab-432e-b6d2-bd6955ca1845",
    operationId: "b5622aa1-81ab-432e-b6d2-bd6955ca1846", sourceReference: "NF 123" }],
};
describe("immutable inventory history", () => {
  it("sorts descending without mutating the response and shows signed quantity, source, batch and support operation", () => {
    const first = history.movements[0]!;
    const input = { ...history, movements: [first, { ...first, id: "b5622aa1-81ab-432e-b6d2-bd6955ca1847", reason: "physical_sale" as const,
      quantityDelta: -3, occurredAt: "2026-11-14T12:00:00Z", lotId: null, sourceReference: null }] };
    render(<InventoryHistory history={input} />);
    const entries = within(screen.getByRole("list", { name: "Movimentos de estoque" })).getAllByRole("listitem");
    expect(entries[0]).toHaveTextContent("Venda física"); expect(entries[0]).toHaveTextContent("-3 un.");
    expect(entries[1]).toHaveTextContent("Reposição"); expect(entries[1]).toHaveTextContent("+5 un.");
    expect(entries[1]).toHaveTextContent("NF 123"); expect(entries[1]).toHaveTextContent(`Lote: ${first.lotId}`);
    expect(entries[1]).toHaveTextContent(`Registro de origem: ${first.referenceId}`);
    expect(entries[1]).toHaveTextContent(`Operação: ${first.operationId}`);
    expect(entries[0]!.querySelector("time")).toHaveAttribute("dateTime", "2026-11-14T12:00:00Z");
    expect(input.movements[0]).toBe(first);
    expect(screen.queryByRole("button", { name: /editar|apagar|excluir|remover/i })).not.toBeInTheDocument();
  });
  it.each<[InventoryMovementReason, string]>([["adjustment", "Ajuste"], ["sale_cancellation", "Estorno de venda"],
    ["online_order", "Pedido online"], ["online_order_cancellation", "Cancelamento de pedido online"], ["return_received", "Devolução recebida"]])("translates %s", (reason, text) => {
    render(<InventoryHistory history={{ ...history, movements: [{ ...history.movements[0]!, reason }] }} />);
    expect(screen.getByRole("listitem")).toHaveTextContent(text);
  });
  it("shows an explicit empty state", () => {
    render(<InventoryHistory history={{ ...history, movements: [] }} />);
    expect(screen.getByRole("status")).toHaveTextContent(/nenhum movimento/i);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
  it("shows error independently from empty state and never presents a failed query as history", () => {
    render(<InventoryHistory error="Não foi possível consultar o histórico." />);
    expect(screen.getByRole("alert")).toHaveTextContent(/não foi possível/i);
    expect(screen.queryByText(/nenhum movimento/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
