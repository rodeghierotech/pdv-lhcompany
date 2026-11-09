import { readSupabasePublicConfig } from "../supabase/config";
import type { CatalogVariantRecord } from "../../features/produtos/catalog-read-model";

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

export async function startNuvemshopImport(input: { accessToken: string; organizationId: string; operationId: string }) {
  const config = readSupabasePublicConfig(import.meta.env);
  if (config.status !== "ready") throw new Error("Configure o Supabase antes de importar o catálogo.");

  const response = await fetch(`${config.url}/functions/v1/import-nuvemshop`, {
    method: "POST",
    headers: { apikey: config.anonKey, Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId: input.organizationId, operationId: input.operationId }),
  });
  if (!response.ok) throw new Error("Não foi possível confirmar a importação no servidor.");
  return response.json() as Promise<{ importId: string; imported: number; linked: number; needsReview: number }>;
}

export type CatalogWorkspace = {
  variants: CatalogVariantRecord[];
  pendingReviews: Array<{ id: string; sku: string; reason: string; created_at: string }>;
};

export async function fetchCatalogWorkspace(accessToken: string): Promise<CatalogWorkspace> {
  const config = readSupabasePublicConfig(import.meta.env);
  if (config.status !== "ready") throw new Error("Configure o Supabase antes de consultar o catálogo.");

  const headers = { apikey: config.anonKey, Authorization: `Bearer ${accessToken}` };
  const [variantsResponse, reviewsResponse] = await Promise.all([
    fetch(`${config.url}/rest/v1/product_variant?select=id,sku,sale_price_in_cents,requires_cost_review,product(name),inventory_balance(quantity)&order=created_at.desc`, { headers }),
    fetch(`${config.url}/rest/v1/catalog_pending_review?select=id,sku,reason,created_at&order=created_at.desc`, { headers }),
  ]);
  if (!variantsResponse.ok || !reviewsResponse.ok) throw new Error("Não foi possível atualizar o catálogo confirmado.");

  return {
    variants: await variantsResponse.json() as CatalogVariantRecord[],
    pendingReviews: await reviewsResponse.json() as CatalogWorkspace["pendingReviews"],
  };
}
