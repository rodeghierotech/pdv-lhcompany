import type { ProductCatalogItem } from "@lh-company/contracts";
import { CircleAlert } from "lucide-react";
import { Button } from "../../../components/shared/Button";
import { cn } from "../../../lib/cn";

interface ProductCatalogProps {
  items: ProductCatalogItem[];
  onSelectVariant: (variantId: string) => void;
}

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const money = (cents: number) => currency.format(cents / 100);
const isLowStock = (item: ProductCatalogItem) => item.tracksInventory && item.quantity <= item.minimumStockQuantity;

export function ProductCatalog({ items, onSelectVariant }: ProductCatalogProps) {
  const productCount = new Set(items.map((item) => item.productId)).size;
  const lowStockCount = items.filter(isLowStock).length;
  const inventoryCost = items.reduce((total, item) => total + (item.tracksInventory ? item.quantity * item.costInCents : 0), 0);

  return (
    <div className="space-y-3">
      <div className="space-y-2 border-y border-border py-3 text-sm">
        <p className="font-medium">{productCount} {productCount === 1 ? "produto" : "produtos"} · {items.length} {items.length === 1 ? "variante" : "variantes"} nesta consulta</p>
        <div aria-label="Conferência desta consulta" className="flex flex-wrap gap-x-6 gap-y-2 text-muted-foreground">
          <p>Custo em estoque: <span className="tabular-nums text-foreground">{money(inventoryCost)}</span></p>
          <p>Variantes com estoque baixo: <span className="tabular-nums text-foreground">{lowStockCount}</span></p>
        </div>
        <p className="text-xs text-muted-foreground">Dados consultados no servidor. Saldos não incluem operações locais pendentes.</p>
        {items.length >= 50 && <p className="text-xs text-muted-foreground">Limite de 50 variantes por consulta. Refine a busca para conferir os demais resultados.</p>}
      </div>
      {items.length === 0 ? (
        <p role="status" className="py-6 text-sm text-muted-foreground">Nenhuma variante encontrada. Altere a busca ou os filtros.</p>
      ) : (
        <table role="table" className="block w-full text-left text-sm md:table">
          <caption className="sr-only">Variantes do catálogo</caption>
          <thead role="rowgroup" className="sr-only md:not-sr-only md:table-header-group">
            <tr role="row" className="border-b border-border text-muted-foreground">
              <th scope="col" className="px-3 py-3 font-medium">Produto e variante</th>
              <th scope="col" className="px-3 py-3 font-medium">SKU</th>
              <th scope="col" className="px-3 py-3 text-right font-medium">Preço</th>
              <th scope="col" className="px-3 py-3 text-right font-medium">Custo unitário</th>
              <th scope="col" className="px-3 py-3 text-right font-medium">Saldo</th>
            </tr>
          </thead>
          <tbody role="rowgroup" className="block md:table-row-group">
            {items.map((item) => {
              const lowStock = isLowStock(item);
              return (
                <tr
                  role="row"
                  key={item.variantId}
                  onClick={() => onSelectVariant(item.variantId)}
                  className="grid cursor-pointer grid-cols-2 gap-x-3 gap-y-2 border-b border-border py-3 hover:bg-accent focus-within:bg-accent md:table-row md:py-0"
                >
                  <td role="cell" className="col-span-2 min-w-0 md:px-3 md:py-3">
                    <Button variant="ghost" onClick={(event) => { event.stopPropagation(); onSelectVariant(item.variantId); }} className="h-auto w-full flex-col items-start gap-1 whitespace-normal px-0 py-1 text-left hover:bg-transparent md:w-auto">
                      <span className="break-words font-semibold">{item.productName}</span>
                      <span className="break-words font-normal text-muted-foreground">
                        {item.attributes.length ? item.attributes.map((attribute) => `${attribute.name}: ${attribute.value}`).join(" · ") : "Sem atributos"}
                      </span>
                    </Button>
                    {(!item.productActive || !item.variantActive) && <p className="text-xs text-muted-foreground">Inativo</p>}
                  </td>
                  <td role="cell" className="col-span-2 break-all md:px-3 md:py-3"><span aria-hidden="true" className="text-muted-foreground md:hidden">SKU: </span>{item.sku}</td>
                  <td role="cell" className="tabular-nums md:px-3 md:py-3 md:text-right"><span aria-hidden="true" className="block text-xs text-muted-foreground md:hidden">Preço</span>{money(item.salePriceInCents)}</td>
                  <td role="cell" className="tabular-nums md:px-3 md:py-3 md:text-right"><span aria-hidden="true" className="block text-xs text-muted-foreground md:hidden">Custo unitário</span>{money(item.costInCents)}</td>
                  <td role="cell" className={cn("col-span-2 md:px-3 md:py-3 md:text-right", lowStock && "text-destructive")}>
                    {item.tracksInventory ? (
                      <>
                        <span aria-hidden="true" className="text-muted-foreground md:hidden">Saldo: </span>
                        <span className="font-medium tabular-nums">{item.quantity} un.</span>
                        {lowStock && <span className="mt-1 flex items-center gap-1 text-xs font-medium md:justify-end"><CircleAlert aria-hidden="true" className="size-4 shrink-0" />Estoque baixo · mínimo {item.minimumStockQuantity}</span>}
                      </>
                    ) : <span className="text-muted-foreground">Sem controle de estoque</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
