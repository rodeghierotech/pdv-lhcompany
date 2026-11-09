import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { z } from "npm:zod@3.24.1";

import { toCatalogCandidates } from "../_shared/catalog-command.ts";
import { fetchNuvemshopProducts } from "../_shared/nuvemshop-client.ts";

const RequestSchema = z.object({ organizationId: z.string().uuid(), operationId: z.string().uuid() });

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const nuvemshopStoreId = Deno.env.get("NUVEMSHOP_STORE_ID");
const nuvemshopToken = Deno.env.get("NUVEMSHOP_ACCESS_TOKEN");
const nuvemshopUserAgent = Deno.env.get("NUVEMSHOP_USER_AGENT");
const defaultLocationId = Deno.env.get("NUVEMSHOP_DEFAULT_LOCATION_ID");

if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey || !nuvemshopStoreId || !nuvemshopToken || !nuvemshopUserAgent || !defaultLocationId) {
  throw new Error("Segredos obrigatórios da função de importação não configurados.");
}

const adminClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function bytesToUuid(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function operationIdForCandidate(importOperationId: string, externalVariantId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${importOperationId}:${externalVariantId}`));
  return bytesToUuid(new Uint8Array(digest));
}

async function importTotals(importId: string) {
  const { data, error } = await adminClient.from("catalog_import_operation").select("outcome").eq("import_id", importId);
  if (error) throw new Error("Não foi possível consultar o resultado da importação.");
  return (data ?? []).reduce((totals, item) => ({
    imported: totals.imported + Number(item.outcome === "imported"),
    linked: totals.linked + Number(item.outcome === "linked"),
    needsReview: totals.needsReview + Number(item.outcome === "needs_review"),
  }), { imported: 0, linked: 0, needsReview: 0 });
}

Deno.serve(async (request) => {
  let activeImportId: string | undefined;
  if (request.method !== "POST") return new Response("Método não permitido", { status: 405 });

  try {
    const bearer = request.headers.get("Authorization");
    if (!bearer?.startsWith("Bearer ")) return new Response("Não autenticado", { status: 401 });

    const input = RequestSchema.parse(await request.json());
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: bearer } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser(bearer.slice(7));
    if (userError || !userData.user) return new Response("Não autenticado", { status: 401 });

    const { data: membership, error: membershipError } = await userClient
      .from("organization_member")
      .select("organization_id")
      .eq("organization_id", input.organizationId)
      .maybeSingle();
    if (membershipError || !membership) return new Response("Sem acesso à organização", { status: 403 });

    const { data: existingImport, error: existingImportError } = await adminClient
      .from("catalog_import")
      .select("id, status")
      .eq("organization_id", input.organizationId)
      .eq("operation_id", input.operationId)
      .maybeSingle();
    if (existingImportError) throw new Error("Não foi possível consultar a importação.");

    const { data: catalogImport, error: importError } = existingImport
      ? { data: existingImport, error: null }
      : await adminClient
        .from("catalog_import")
        .insert({ organization_id: input.organizationId, operation_id: input.operationId, source: "nuvemshop", status: "pending" })
        .select("id, status")
        .single();
    if (importError || !catalogImport) throw new Error("Não foi possível iniciar a importação.");
    activeImportId = catalogImport.id;

    if (catalogImport.status === "completed" || catalogImport.status === "needs_review") {
      return Response.json({ importId: catalogImport.id, ...(await importTotals(catalogImport.id)) });
    }

    const products = await fetchNuvemshopProducts({
      storeId: nuvemshopStoreId,
      accessToken: nuvemshopToken,
      userAgent: nuvemshopUserAgent,
    });
    const candidates = toCatalogCandidates({ products, defaultLocationId });
    for (const candidate of candidates) {
      const { data, error } = await adminClient.rpc("apply_nuvemshop_catalog_candidate", {
        import_id: catalogImport.id,
        candidate,
        operation_id: await operationIdForCandidate(input.operationId, candidate.externalVariantId),
        actor_id: userData.user.id,
      });
      if (error) throw new Error("Não foi possível aplicar um item da importação.");
    }

    const totals = await importTotals(catalogImport.id);

    await adminClient.from("catalog_import").update({
      status: totals.needsReview > 0 ? "needs_review" : "completed",
    }).eq("id", catalogImport.id);

    return Response.json({ importId: catalogImport.id, ...totals });
  } catch (error) {
    if (activeImportId) {
      await adminClient.from("catalog_import").update({ status: "recoverable_failure" }).eq("id", activeImportId);
    }
    console.error("Falha na importação de catálogo.", error instanceof Error ? error.message : "Erro desconhecido");
    return new Response("Não foi possível importar o catálogo.", { status: 422 });
  }
});
