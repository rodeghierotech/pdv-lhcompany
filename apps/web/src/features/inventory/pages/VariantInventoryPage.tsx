import type { InventoryHistoryResponse } from "@lh-company/contracts";
import { ArrowLeft, PackagePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/shared/Button";
import { FeedbackMessage } from "../../../components/shared/FeedbackMessage";
import { ApiError } from "../../../lib/api-client";
import { cn } from "../../../lib/cn";
import { formatCents } from "../../../lib/money";
import { getInventoryHistory, replenishInventory } from "../api/inventory-api";
import { InventoryHistory } from "../components/InventoryHistory";
import { ReplenishmentForm } from "../components/ReplenishmentForm";

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; history: InventoryHistoryResponse };
type EntryState = "idle" | "pending" | "failed" | "confirmed";

export function VariantInventoryPage({ variantId, onBack }: { variantId: string; onBack: () => void }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [replenishing, setReplenishing] = useState(false);
  const [entry, setEntry] = useState<EntryState>("idle");
  const heading = useRef<HTMLHeadingElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let current = true;
    setState({ kind: "loading" }); setEntry("idle");
    getInventoryHistory(variantId).then(
      (history) => { if (current) setState({ kind: "ready", history }); },
      (error: unknown) => { if (current) setState({ kind: "error", message: error instanceof ApiError ? error.message : "Não foi possível consultar o estoque. Tente novamente." }); },
    );
    return () => { current = false; };
  }, [variantId, attempt]);
  useEffect(() => {
    if (replenishing) heading.current?.focus();
    else if (state.kind === "ready") detailHeading.current?.focus();
  }, [replenishing, state.kind]);

  return <section aria-label="Detalhe do estoque da variante" className="space-y-5">
    <Button variant="ghost" onClick={onBack} disabled={entry === "pending"}><ArrowLeft aria-hidden="true" className="size-4" />Voltar ao catálogo</Button>
    {state.kind === "loading" && <FeedbackMessage>Carregando estoque e histórico do servidor…</FeedbackMessage>}
    {state.kind === "error" && <div className="space-y-3"><InventoryHistory error={`${state.message} Os dados desta consulta não foram confirmados.`} /><Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</Button></div>}
    {state.kind === "ready" && <div className={cn("grid gap-6", replenishing && "md:grid-cols-5")}>
      <div className={cn("min-w-0 space-y-5", replenishing && "hidden md:col-span-2 md:block")}>
        <header className="space-y-1"><h1 ref={detailHeading} tabIndex={-1} className="break-words text-xl font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">{state.history.productName}</h1>
          <p className="break-words text-sm">SKU: {state.history.sku}</p>
          <p className="break-words text-sm text-muted-foreground">{state.history.attributes.length ? state.history.attributes.map(({ name, value }) => `${name}: ${value}`).join(" · ") : "Sem atributos"}</p>
        </header>
        <section aria-label="Dados comerciais do estoque" className="space-y-3 border-y border-border py-4">
          <h2 className="text-base font-semibold">Dados comerciais do estoque</h2>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <dt>Saldo atual</dt><dd className="text-right font-semibold tabular-nums">{state.history.quantity} un.</dd>
            <dt>Custo médio unitário</dt><dd className="text-right tabular-nums">R$ {formatCents(state.history.costInCents)}</dd>
            <dt>Custo estimado em estoque</dt><dd className="text-right tabular-nums">R$ {formatCents(state.history.estimatedStockCostInCents)}</dd>
          </dl>
          <p className="text-xs text-muted-foreground">Últimos dados recebidos do servidor. Operações locais pendentes não estão incluídas.</p>
        </section>
        {!replenishing && <Button onClick={() => { setReplenishing(true); setEntry("idle"); }}><PackagePlus aria-hidden="true" className="size-4" />Registrar reposição</Button>}
        <InventoryHistory history={state.history} />
      </div>
      <div className={cn("min-w-0 space-y-5", replenishing && "md:col-span-3")}>
        <section aria-label="Estado no servidor" className="space-y-2">
          <h2 className="text-sm font-semibold">Estado no servidor</h2>
          <FeedbackMessage variant={entry === "confirmed" ? "success" : "info"}>
            {entry === "pending" ? "Aguardando confirmação da reposição no servidor. Saldo e custos anteriores mantidos."
              : entry === "failed" ? "Reposição sem confirmação. Confira o resultado no servidor ou repita a mesma operação."
                : entry === "confirmed" ? "Entrada confirmada no servidor. Saldo, custos e histórico atualizados."
                  : "Confirmado no servidor"}
          </FeedbackMessage>
        </section>
        {replenishing && <section aria-label="Registrar reposição" className="space-y-4 border-t border-border pt-4 md:border-t-0 md:border-l md:pt-0 md:pl-6">
          <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">Reposição · {state.history.sku}</h2>
          <ReplenishmentForm variant={state.history} currentQuantity={state.history.quantity} onCancel={() => { setReplenishing(false); setAttempt((value) => value + 1); }} onSubmit={async (command) => {
            setEntry("pending");
            try {
              const history = await replenishInventory(command);
              setState({ kind: "ready", history }); setEntry("confirmed"); setReplenishing(false);
            } catch (error: unknown) { setEntry("failed"); throw error; }
          }} />
        </section>}
      </div>
    </div>}
  </section>;
}
