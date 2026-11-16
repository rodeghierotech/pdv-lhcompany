import { CreateReplenishmentCommandSchema, InventoryHistoryResponseSchema, ProductVariantSchema, type CreateReplenishmentCommand, type InventoryHistoryResponse } from "@lh-company/contracts";
import { ApiError, requestJson } from "../../../lib/api-client";

function parseHistory(body: unknown): InventoryHistoryResponse {
  const parsed = InventoryHistoryResponseSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(200, "INVALID_RESPONSE", "A API retornou dados de estoque inválidos. Consulte o servidor antes de tentar novamente.");
  return parsed.data;
}

export async function replenishInventory(command: CreateReplenishmentCommand): Promise<InventoryHistoryResponse> {
  const parsed = CreateReplenishmentCommandSchema.safeParse(command);
  if (!parsed.success) throw new ApiError(0, "INVALID_REQUEST", "Confira os campos da reposição.");
  return parseHistory(await requestJson<unknown>("/inventory/replenishments", { method: "POST", body: JSON.stringify(parsed.data) }));
}

export async function getInventoryHistory(variantId: string): Promise<InventoryHistoryResponse> {
  const parsed = ProductVariantSchema.shape.id.safeParse(variantId);
  if (!parsed.success) throw new ApiError(0, "INVALID_REQUEST", "Confira a variante para consultar o estoque.");
  return parseHistory(await requestJson<unknown>(`/inventory/variants/${parsed.data}/history`));
}
