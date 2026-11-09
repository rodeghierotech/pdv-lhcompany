import { useState } from "react";
import { Download, Plus, RefreshCw } from "lucide-react";
import { catalogFeedback, type CatalogImportStatus } from "./catalog-view-model";
import { createManualCatalogProduct, startNuvemshopImport } from "../../lib/catalog/catalog-api";
import { toManualCatalogRequest } from "./catalog-form";

export function CatalogPage({ accessToken, organizationId }: { accessToken: string; organizationId: string }) {
  const [status, setStatus] = useState<CatalogImportStatus>("pending");
  const [productName, setProductName] = useState("");
  const [sku, setSku] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [cost, setCost] = useState("");
  const [initialQuantity, setInitialQuantity] = useState("0");
  const [importOperationId, setImportOperationId] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const feedback = catalogFeedback(status);

  return <section className="space-y-4" aria-labelledby="catalog-title">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 id="catalog-title" className="text-lg font-semibold">Produtos e estoque</h1><p className="text-sm text-muted-foreground">Importe o catálogo inicial ou complemente itens manualmente.</p></div>
      <div className="flex gap-2"><button className="border-border bg-surface inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium" onClick={async () => { if (!window.confirm("Importar o catálogo inicial da Nuvemshop? Reimportações divergentes ficarão pendentes para revisão.")) return; const operationId = importOperationId ?? crypto.randomUUID(); setImportOperationId(operationId); setFormError(undefined); setStatus("pending"); try { const result = await startNuvemshopImport({ accessToken, organizationId, operationId }); setStatus(result.needsReview > 0 ? "needs_review" : "completed"); setImportOperationId(undefined); } catch (error) { setStatus("recoverable_failure"); setFormError(error instanceof Error ? error.message : "Erro ao importar catálogo."); } }}><Download className="size-4" />Importar Nuvemshop</button><button className="bg-foreground text-background inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium" onClick={() => document.getElementById("manual-product")?.scrollIntoView()}><Plus className="size-4" />Novo produto</button></div>
    </div>
    <div className="border-border bg-surface rounded-lg border p-4" role="status"><div className="flex items-center gap-2"><RefreshCw className="text-muted-foreground size-4" /><strong className="text-sm">{feedback.title}</strong></div><p className="text-muted-foreground mt-1 text-sm">{feedback.confirmed ? "Dados confirmados pelo servidor." : "Nenhum dado pendente é tratado como confirmado."}</p></div>
    <form id="manual-product" className="border-border bg-surface grid gap-3 rounded-lg border p-4 sm:grid-cols-2" onSubmit={async (event) => { event.preventDefault(); setFormError(undefined); setStatus("pending"); try { await createManualCatalogProduct({ ...toManualCatalogRequest({ name: productName, sku, salePrice, cost, initialQuantity }, crypto.randomUUID()), accessToken }); setStatus("completed"); setProductName(""); setSku(""); setSalePrice(""); setCost(""); setInitialQuantity("0"); } catch (error) { setStatus("recoverable_failure"); setFormError(error instanceof Error ? error.message : "Erro ao salvar produto."); } }}>
      <h2 className="sm:col-span-2 text-base font-semibold">Cadastro manual complementar</h2>
      <label className="grid gap-1 text-sm">Nome do produto<input required value={productName} onChange={(event) => setProductName(event.target.value)} className="border-border rounded-md border px-3 py-2" /></label>
      <label className="grid gap-1 text-sm">SKU da variante<input required value={sku} onChange={(event) => setSku(event.target.value)} className="border-border rounded-md border px-3 py-2" /></label>
      <label className="grid gap-1 text-sm">Preço de venda<input required inputMode="decimal" value={salePrice} onChange={(event) => setSalePrice(event.target.value)} className="border-border rounded-md border px-3 py-2" placeholder="0,00" /></label>
      <label className="grid gap-1 text-sm">Custo unitário (opcional)<input inputMode="decimal" value={cost} onChange={(event) => setCost(event.target.value)} className="border-border rounded-md border px-3 py-2" placeholder="0,00" /></label>
      <label className="grid gap-1 text-sm">Quantidade inicial<input required min="0" step="1" inputMode="numeric" value={initialQuantity} onChange={(event) => setInitialQuantity(event.target.value)} className="border-border rounded-md border px-3 py-2" /></label>
      <p className="text-muted-foreground text-sm sm:col-span-2">Se o custo ficar em branco, o item será salvo com custo zero e pendente de revisão de margem.</p>
      <button className="bg-foreground text-background w-fit rounded-md px-3 py-2 text-sm font-medium sm:col-span-2" type="submit">Salvar como pendente de confirmação</button>
      {formError ? <p className="text-sm text-muted-foreground sm:col-span-2" role="alert">{formError}</p> : null}
    </form>
  </section>;
}
