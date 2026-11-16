import { CreateReplenishmentCommandSchema, type CreateReplenishmentCommand, type InventoryHistoryResponse } from "@lh-company/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "../../../components/shared/Button";
import { FeedbackMessage } from "../../../components/shared/FeedbackMessage";
import { TextField } from "../../../components/shared/TextField";
import { ApiError } from "../../../lib/api-client";
import { formatCents, parseBrazilianMoneyToCents } from "../../../lib/money";
export interface ReplenishmentFormProps {
  variant: InventoryHistoryResponse;
  currentQuantity: number;
  onSubmit: (command: CreateReplenishmentCommand) => Promise<void>;
  onCancel: () => void;
  operationIdFactory?: () => string;
}
export function ReplenishmentForm({ variant, currentQuantity, onSubmit, onCancel, operationIdFactory = () => crypto.randomUUID() }: ReplenishmentFormProps) {
  const [operationId] = useState(operationIdFactory);
  const [quantity, setQuantity] = useState("");
  const [cost, setCost] = useState("");
  const [reference, setReference] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reviewed, setReviewed] = useState<CreateReplenishmentCommand | null>(null);
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [failure, setFailure] = useState<{ message: string; reconcile: boolean } | null>(null);
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const summary = useRef<HTMLHeadingElement>(null);
  const quantityField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (Object.keys(errors).length) form.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);
  useEffect(() => { if (reviewed) summary.current?.focus(); else quantityField.current?.focus(); }, [reviewed]);

  function review() {
    const nextErrors: Record<string, string> = {};
    const amount = /^\d+$/.test(quantity.trim()) ? Number(quantity) : NaN;
    if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(currentQuantity + amount)) {
      nextErrors.quantity = "Informe uma quantidade inteira positiva dentro do limite permitido.";
    }
    let cents = NaN;
    try { cents = parseBrazilianMoneyToCents(cost); }
    catch { nextErrors.unitCostInCents = "Informe um custo como 80,00, sem sinal ou símbolo de moeda."; }
    if (Number.isSafeInteger(cents) && Number.isSafeInteger(amount) && !Number.isSafeInteger(cents * amount)) {
      nextErrors.unitCostInCents = "O custo total da entrada ultrapassa o limite permitido.";
    }
    const parsed = CreateReplenishmentCommandSchema.safeParse({ operationId, variantId: variant.variantId,
      quantity: amount, unitCostInCents: cents, ...(reference.trim() ? { sourceReference: reference.trim() } : {}),
    });
    if (!parsed.success) for (const issue of parsed.error.issues) {
      const field = String(issue.path[0]);
      nextErrors[field] ??= field === "sourceReference" ? "Use até 200 caracteres na referência." : "Confira este campo.";
    }
    setErrors(nextErrors);
    if (parsed.success && !Object.keys(nextErrors).length) { setReviewed(parsed.data); setFailure(null); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || complete || failure?.reconcile) return;
    if (!reviewed) { review(); return; }
    submitting.current = true;
    setPending(true);
    setFailure(null);
    try { await onSubmit(reviewed); setComplete(true); }
    catch (error: unknown) {
      const reconcile = error instanceof ApiError && error.code === "OPERATION_PAYLOAD_CONFLICT";
      setFailure({ reconcile, message: reconcile
        ? "Esta operação pode ter sido confirmada com outros dados. Confira o saldo e o histórico no servidor antes de iniciar outra entrada."
        : `${error instanceof ApiError ? error.message : "Não foi possível concluir a entrada."} Seus campos foram preservados; tente novamente com a mesma operação.`,
      });
      submitting.current = false;
    } finally { setPending(false); }
  }

  return <form ref={form} aria-label="Reposição de estoque" onSubmit={(event) => { void submit(event); }} noValidate className="space-y-5">
    <p className="text-sm text-muted-foreground">A entrada cria um lote e um movimento auditável. O recebimento usa o horário de confirmação do servidor; não permite data retroativa.</p>
    {failure && <div className="space-y-3"><FeedbackMessage variant="error">{failure.message}</FeedbackMessage>
      {failure.reconcile && <Button variant="secondary" onClick={onCancel}>Voltar e consultar o servidor</Button>}
    </div>}
    <fieldset disabled={pending || complete || Boolean(reviewed)} className="min-w-0 space-y-4">
      <legend className="sr-only">Campos da entrada</legend>
      <TextField ref={quantityField} label="Quantidade de entrada" inputMode="numeric" value={quantity} onChange={(event) => setQuantity(event.target.value)} required {...(errors.quantity ? { error: errors.quantity } : {})} />
      <TextField label="Custo unitário (R$)" inputMode="decimal" value={cost} onChange={(event) => setCost(event.target.value)} placeholder="80,00" required {...(errors.unitCostInCents ? { error: errors.unitCostInCents } : {})} />
      <TextField label="Referência ou lote do fornecedor" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={200} hint="Opcional. Ex.: nota fiscal ou lote do fornecedor." {...(errors.sourceReference ? { error: errors.sourceReference } : {})} />
    </fieldset>
    {reviewed && <section aria-label="Conferência da entrada" className="space-y-3 border-y border-border py-4">
      <h3 ref={summary} tabIndex={-1} className="font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">Conferência da entrada</h3>
      <p className="break-words text-sm">{variant.productName} · {variant.sku}<br />{variant.attributes.map(({ name, value }) => `${name}: ${value}`).join(" · ")}</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        <dt>Entrada</dt><dd className="text-right tabular-nums">+{reviewed.quantity} un.</dd>
        <dt>Custo unitário</dt><dd className="text-right tabular-nums">R$ {formatCents(reviewed.unitCostInCents)}</dd>
        <dt>Custo da entrada</dt><dd className="text-right tabular-nums">R$ {formatCents(reviewed.quantity * reviewed.unitCostInCents)}</dd>
        <dt>Saldo anterior</dt><dd className="text-right tabular-nums">{currentQuantity} un.</dd>
        <dt>Saldo projetado</dt><dd className="text-right font-semibold tabular-nums">{currentQuantity + reviewed.quantity} un.</dd>
      </dl>
      <p className="break-words text-sm">Referência: {reviewed.sourceReference || "Não informada"}</p>
      <p className="text-xs text-muted-foreground">Projeção para conferência. O saldo e o custo médio serão atualizados somente após a resposta do servidor.</p>
    </section>}
    <div className="flex flex-wrap gap-3">
      <Button type="submit" loading={pending} disabled={complete || Boolean(failure?.reconcile)}>{reviewed ? "Registrar entrada auditável" : "Conferir entrada"}</Button>
      {reviewed && <Button variant="secondary" disabled={pending || complete || Boolean(failure?.reconcile)} onClick={() => { setReviewed(null); setFailure(null); }}>Revisar campos</Button>}
      <Button variant="ghost" disabled={pending || complete} onClick={onCancel}>Cancelar</Button>
    </div>
  </form>;
}
