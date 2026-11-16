import type { InventoryHistoryResponse, InventoryMovementReason } from "@lh-company/contracts";
import { FeedbackMessage } from "../../../components/shared/FeedbackMessage";

const reasons: Record<InventoryMovementReason, string> = {
  replenishment: "Reposição", adjustment: "Ajuste", physical_sale: "Venda física", sale_cancellation: "Estorno de venda",
  online_order: "Pedido online", online_order_cancellation: "Cancelamento de pedido online", return_received: "Devolução recebida",
};
const date = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

export function InventoryHistory({ history, error }: { history?: InventoryHistoryResponse; error?: string }) {
  const movements = history ? [...history.movements].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || b.id.localeCompare(a.id)) : [];
  return <section aria-label="Histórico de estoque" className="space-y-3">
    <h2 className="text-base font-semibold">Histórico de estoque</h2>
    {error ? <FeedbackMessage variant="error">{error}</FeedbackMessage> : history && <>
      <p className="text-xs text-muted-foreground">Movimentos imutáveis, do mais recente para o mais antigo. Horários registrados pelo servidor.</p>
      {movements.length ? <ol aria-label="Movimentos de estoque" className="divide-y divide-border border-y border-border">
        {movements.map((movement) => <li key={movement.id} className="space-y-2 py-3 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><p className="font-medium">{reasons[movement.reason]}</p><time dateTime={movement.occurredAt} className="text-xs text-muted-foreground">{date.format(new Date(movement.occurredAt))}</time></div>
            <p className="font-semibold tabular-nums">{movement.quantityDelta > 0 ? "+" : ""}{movement.quantityDelta} un.</p>
          </div>
          <div className="space-y-1 break-all text-xs text-muted-foreground">
            {movement.sourceReference && <p className="break-words">Referência: {movement.sourceReference}</p>}
            {movement.referenceId && <p>Registro de origem: {movement.referenceId}</p>}
            {movement.lotId && <p>Lote: {movement.lotId}</p>}
            {movement.operationId && <p>Operação: {movement.operationId}</p>}
          </div>
        </li>)}
      </ol> : <p role="status" className="py-4 text-sm text-muted-foreground">Nenhum movimento de estoque registrado para esta variante.</p>}
      {movements.length >= 50 && <p className="text-xs text-muted-foreground">Exibindo até 50 movimentos mais recentes desta variante.</p>}
    </>}
  </section>;
}
