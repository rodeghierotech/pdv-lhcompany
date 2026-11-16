import type { ProductCatalogItem, ProductCatalogQuery } from "@lh-company/contracts";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../../components/shared/Button";
import { FeedbackMessage } from "../../../components/shared/FeedbackMessage";
import { TextField } from "../../../components/shared/TextField";
import { ApiError } from "../../../lib/api-client";
import { listProducts } from "../api/products-api";
import { ProductCatalog } from "../components/ProductCatalog";

export interface ProductCatalogPageProps {
  onCreateProduct: () => void;
  onSelectVariant: (variantId: string) => void;
}

const filters = [
  { id: "active", label: "Ativos", status: "active", lowStockOnly: false },
  { id: "low", label: "Estoque baixo", status: "active", lowStockOnly: true },
  { id: "inactive", label: "Inativos", status: "inactive", lowStockOnly: false },
  { id: "all", label: "Todos", status: "all", lowStockOnly: false },
] as const;

type CatalogState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; items: ProductCatalogItem[] };

export function ProductCatalogPage({ onCreateProduct, onSelectVariant }: ProductCatalogPageProps) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState<ProductCatalogQuery>({ search: "", lowStockOnly: false, status: "active", limit: 50 });
  const [state, setState] = useState<CatalogState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery((current) => current.search === search.trim() ? current : { ...current, search: search.trim() });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    listProducts(query).then(
      (items) => { if (current) setState({ kind: "ready", items }); },
      (error: unknown) => {
        if (current) setState({ kind: "error", message: error instanceof ApiError ? error.message : "Não foi possível consultar o catálogo. Tente novamente." });
      },
    );
    return () => { current = false; };
  }, [query, attempt]);

  return (
    <section aria-labelledby="catalog-title" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 id="catalog-title" className="text-xl font-semibold">Produtos e estoque</h1>
          <p className="mt-1 text-sm text-muted-foreground">Consulte peças, variantes e saldos para a conferência da loja.</p>
        </div>
        <Button onClick={onCreateProduct}><Plus aria-hidden="true" className="size-4" />Novo produto</Button>
      </div>
      <div className="space-y-3">
        <TextField label="Buscar produtos" hint="Nome, SKU ou código de barras" value={search} onChange={(event) => setSearch(event.target.value)} autoComplete="off" />
        <div role="group" aria-label="Filtrar catálogo" className="flex flex-wrap gap-2">
          {filters.map((filter) => {
            const selected = query.status === filter.status && query.lowStockOnly === filter.lowStockOnly;
            return <Button key={filter.id} variant={selected ? "primary" : "secondary"} aria-pressed={selected} onClick={() => {
              if (!selected || query.search !== search.trim()) setQuery({ ...query, search: search.trim(), status: filter.status, lowStockOnly: filter.lowStockOnly });
            }}>{filter.label}</Button>;
          })}
        </div>
      </div>
      {state.kind === "loading" && <FeedbackMessage>Carregando catálogo do servidor…</FeedbackMessage>}
      {state.kind === "error" && <div className="space-y-3"><FeedbackMessage variant="error">{state.message} Os saldos desta consulta não foram confirmados.</FeedbackMessage><Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</Button></div>}
      {state.kind === "ready" && <ProductCatalog items={state.items} onSelectVariant={onSelectVariant} />}
    </section>
  );
}
