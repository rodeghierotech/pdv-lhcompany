import { readSupabasePublicConfig } from "../supabase/config";

export type CreateManualCatalogProductInput = {
  name: string;
  sku: string;
  salePriceInCents: number;
  costInCents: number;
  initialQuantity: number;
  operationId: string;
  accessToken: string;
};

export async function createManualCatalogProduct(input: CreateManualCatalogProductInput) {
  const config = readSupabasePublicConfig(import.meta.env);
  if (config.status !== "ready") throw new Error("Configure o Supabase antes de salvar produtos.");

  const response = await fetch(`${config.url}/rest/v1/rpc/create_catalog_product`, {
    method: "POST",
    headers: { apikey: config.anonKey, Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      product_name: input.name,
      variant_sku: input.sku,
      sale_price_in_cents: input.salePriceInCents,
      cost_in_cents: input.costInCents,
      initial_quantity: input.initialQuantity,
      operation_id: input.operationId,
    }),
  });
  if (!response.ok) throw new Error("Não foi possível confirmar o produto no servidor.");
}

export async function startNuvemshopImport(input: { accessToken: string; organizationId: string }) {
  const config = readSupabasePublicConfig(import.meta.env);
  if (config.status !== "ready") throw new Error("Configure o Supabase antes de importar o catálogo.");

  const response = await fetch(`${config.url}/functions/v1/import-nuvemshop`, {
    method: "POST",
    headers: { apikey: config.anonKey, Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId: input.organizationId }),
  });
  if (!response.ok) throw new Error("Não foi possível confirmar a importação no servidor.");
  return response.json() as Promise<{ importId: string; imported: number; linked: number; needsReview: number }>;
}
