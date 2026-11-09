import { readSupabasePublicConfig } from "../supabase/config";

export async function createManualCatalogProduct(input: { name: string; sku: string }) {
  const config = readSupabasePublicConfig(import.meta.env);
  if (config.status !== "ready") throw new Error("Configure o Supabase antes de salvar produtos.");

  const response = await fetch(`${config.url}/rest/v1/rpc/create_catalog_product`, {
    method: "POST",
    headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ product_name: input.name, variant_sku: input.sku, sale_price_in_cents: 0, cost_in_cents: 0 }),
  });
  if (!response.ok) throw new Error("Não foi possível confirmar o produto no servidor.");
}
