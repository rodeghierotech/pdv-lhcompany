import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { formatBRL, PAYMENT_METHOD_LABEL, PAYMENT_METHODS, parseBRLToCents } from '@pdv/shared';
import type { PaymentMethod, ReturnPreviewDTO, SaleDTO } from '@pdv/shared';
import { PaymentStatusBadge, SaleStatusBadge } from '@/components/SaleBadges';
import { ErrorNotice, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Table, Td, Th } from '@/components/ui/display';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/form';
import { ReceiveDialog } from '@/components/ReceiveDialog';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';
import { formatDateOnly, formatDateTime, newIdempotencyKey } from '@/lib/utils';
import { centsToInput } from '@/lib/variantForm';

function invalidateAll(queryClient: ReturnType<typeof useQueryClient>) {
  for (const key of [
    'sales',
    'sale',
    'products',
    'product',
    'low-stock',
    'pos-search',
    'customers',
    'movements',
  ]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

function CancelDialog({ sale, onClose }: { sale: SaleDTO; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const key = useRef(newIdempotencyKey());
  const cancel = useMutation({
    mutationFn: () =>
      api(`/sales/${sale.id}/cancel`, {
        method: 'POST',
        body: { reason: reason.trim(), idempotencyKey: key.current },
      }),
    onSuccess: () => {
      toast.success(`Venda #${sale.number} cancelada`);
      invalidateAll(queryClient);
      onClose();
    },
  });
  return (
    <DialogContent
      title={`Cancelar venda #${sale.number}`}
      description="Devolve todo o estoque e estorna os recebimentos. Não pode ser desfeito."
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim().length >= 3) cancel.mutate();
        }}
      >
        <Field label="Motivo *" htmlFor="cancel-reason">
          <Input
            id="cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
        </Field>
        <ErrorNotice error={cancel.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={reason.trim().length < 3 || cancel.isPending}
          >
            Confirmar cancelamento
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

interface RefundRow {
  id: string;
  method: PaymentMethod;
  amount: string;
}

function ReturnDialog({ sale, onClose }: { sale: SaleDTO; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [refunds, setRefunds] = useState<RefundRow[]>([]);
  const key = useRef(newIdempotencyKey());

  const items = Object.entries(qty)
    .filter(([, q]) => q > 0)
    .map(([saleItemId, quantity]) => ({ saleItemId, quantity }));
  const itemsKey = JSON.stringify(items);

  const preview = useQuery({
    queryKey: ['return-preview', sale.id, itemsKey],
    queryFn: () =>
      api<{ preview: ReturnPreviewDTO }>(`/sales/${sale.id}/returns/preview`, {
        method: 'POST',
        body: { items },
      }),
    enabled: items.length > 0,
  });
  const p = preview.data?.preview;

  // Reembolso sugerido: um recebimento na forma usada na venda.
  useEffect(() => {
    if (!p) return;
    const method = sale.payments.find((x) => x.kind === 'recebimento')?.method ?? 'dinheiro';
    setRefunds(
      p.refundDueCents > 0
        ? [{ id: crypto.randomUUID(), method, amount: centsToInput(p.refundDueCents) }]
        : [],
    );
  }, [p?.refundDueCents, p?.valueCents]);

  const parsed = refunds.map((r) => ({ r, cents: parseBRLToCents(r.amount) }));
  const refundSum = parsed.reduce((s, x) => s + (x.cents ?? 0), 0);
  const refundsOk =
    !!p && parsed.every((x) => x.cents !== null && x.cents > 0) && refundSum === p.refundDueCents;

  const send = useMutation({
    mutationFn: () =>
      api(`/sales/${sale.id}/returns`, {
        method: 'POST',
        body: {
          items,
          refunds: parsed.map((x) => ({ method: x.r.method, amountCents: x.cents! })),
          reason: reason.trim(),
          idempotencyKey: key.current,
        },
      }),
    onSuccess: () => {
      toast.success('Devolução registrada');
      invalidateAll(queryClient);
      onClose();
    },
  });

  return (
    <DialogContent
      title={`Devolução — venda #${sale.number}`}
      className="max-w-2xl"
      description="Informe as quantidades devolvidas."
    >
      <div className="space-y-4">
        <Table>
          <thead>
            <tr>
              <Th>Item</Th>
              <Th className="text-right">Disponível</Th>
              <Th className="text-right">Devolver</Th>
            </tr>
          </thead>
          <tbody>
            {sale.items.map((i) => {
              const max = i.quantity - i.returnedQuantity;
              return (
                <tr key={i.id}>
                  <Td>
                    {i.productName} <span className="text-xs text-muted-foreground">{i.sku}</span>
                  </Td>
                  <Td className="text-right tabular-nums">{max}</Td>
                  <Td className="text-right">
                    <Input
                      aria-label={`Devolver ${i.sku}`}
                      inputMode="numeric"
                      className="ml-auto h-9 w-20 text-right"
                      disabled={max === 0}
                      value={qty[i.id] ?? ''}
                      onChange={(e) => {
                        const n = Math.max(
                          0,
                          Math.min(max, Math.floor(Number(e.target.value) || 0)),
                        );
                        setQty({ ...qty, [i.id]: n });
                      }}
                    />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <ErrorNotice error={preview.error} />
        {p && (
          <dl className="space-y-1 rounded-md bg-muted p-3 text-sm">
            <div className="flex justify-between">
              <dt>Valor devolvido</dt>
              <dd className="tabular-nums">{formatBRL(p.valueCents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Abate do débito do cliente</dt>
              <dd className="tabular-nums">{formatBRL(p.debtReductionCents)}</dd>
            </div>
            <div className="flex justify-between font-semibold">
              <dt>Reembolso ao cliente</dt>
              <dd className="tabular-nums">{formatBRL(p.refundDueCents)}</dd>
            </div>
          </dl>
        )}
        {p && p.refundDueCents > 0 && (
          <div className="space-y-2">
            {refunds.map((r, i) => (
              <div key={r.id} className="flex items-center gap-2">
                <Select
                  aria-label={`Forma do reembolso ${i + 1}`}
                  className="h-9 flex-1"
                  value={r.method}
                  onChange={(e) =>
                    setRefunds(
                      refunds.map((x) =>
                        x.id === r.id ? { ...x, method: e.target.value as PaymentMethod } : x,
                      ),
                    )
                  }
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {PAYMENT_METHOD_LABEL[m]}
                    </option>
                  ))}
                </Select>
                <Input
                  aria-label={`Valor do reembolso ${i + 1}`}
                  inputMode="decimal"
                  className="h-9 w-28 text-right"
                  value={r.amount}
                  onChange={(e) =>
                    setRefunds(
                      refunds.map((x) => (x.id === r.id ? { ...x, amount: e.target.value } : x)),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-9"
                  aria-label={`Remover reembolso ${i + 1}`}
                  onClick={() => setRefunds(refunds.filter((x) => x.id !== r.id))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                setRefunds([
                  ...refunds,
                  { id: crypto.randomUUID(), method: 'dinheiro', amount: '' },
                ])
              }
            >
              <Plus /> Dividir reembolso
            </Button>
            {!refundsOk && (
              <p className="text-xs text-destructive">
                Os reembolsos devem somar exatamente {formatBRL(p.refundDueCents)}.
              </p>
            )}
          </div>
        )}
        <Field label="Motivo *" htmlFor="return-reason">
          <Input id="return-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorNotice error={send.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button
            disabled={
              !p ||
              reason.trim().length < 3 ||
              (p.refundDueCents > 0 && !refundsOk) ||
              send.isPending
            }
            onClick={() => send.mutate()}
          >
            Confirmar devolução
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}

function DueDateDialog({ sale, onClose }: { sale: SaleDTO; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [date, setDate] = useState(sale.dueDate ?? '');
  const save = useMutation({
    mutationFn: () =>
      api(`/sales/${sale.id}/due-date`, { method: 'PATCH', body: { dueDate: date || null } }),
    onSuccess: () => {
      toast.success('Vencimento atualizado');
      invalidateAll(queryClient);
      onClose();
    },
  });
  return (
    <DialogContent
      title={`Vencimento — venda #${sale.number}`}
      description="Opcional. Não bloqueia novas vendas."
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Data" htmlFor="due-date-edit">
          <Input
            id="due-date-edit"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <ErrorNotice error={save.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button type="submit" disabled={save.isPending}>
            Salvar
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

export function SaleDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const [dialog, setDialog] = useState<'cancel' | 'return' | 'receive' | 'due' | null>(null);
  const { data, error } = useQuery({
    queryKey: ['sale', id],
    queryFn: () => api<{ sale: SaleDTO }>(`/sales/${id}`),
  });
  const sale = data?.sale;

  return (
    <>
      <PageHeader
        title={sale ? `Venda #${sale.number}` : 'Venda'}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/vendas">
                <ArrowLeft /> Vendas
              </Link>
            </Button>
            {sale?.status === 'concluida' &&
              sale.balanceCents > 0 &&
              sale.customerId &&
              can('debt:receive') && (
                <Button onClick={() => setDialog('receive')}>Receber saldo</Button>
              )}
            {sale?.status === 'concluida' && can('sale:return') && (
              <Button variant="outline" onClick={() => setDialog('return')}>
                Devolver itens
              </Button>
            )}
            {sale?.status === 'concluida' && sale.returns.length === 0 && can('sale:cancel') && (
              <Button variant="destructive" onClick={() => setDialog('cancel')}>
                Cancelar venda
              </Button>
            )}
          </>
        }
      />
      <ErrorNotice error={error} />
      {sale && (
        <div className="space-y-4">
          <Card>
            <CardContent className="grid gap-3 pt-4 text-sm sm:grid-cols-4 sm:pt-5">
              <div>
                <p className="text-muted-foreground">Data</p>
                <p>{formatDateTime(sale.createdAt)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Cliente</p>
                <p>{sale.customerName ?? '—'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Vendedor</p>
                <p>{sale.sellerName}</p>
              </div>
              <div className="flex items-start gap-2">
                <SaleStatusBadge status={sale.status} />
                <PaymentStatusBadge status={sale.paymentStatus} />
              </div>
              {sale.balanceCents > 0 && sale.status === 'concluida' && (
                <div className="sm:col-span-4 flex items-center gap-3">
                  <span className="text-muted-foreground">Vencimento:</span>
                  <span>{sale.dueDate ? formatDateOnly(sale.dueDate) : 'não definido'}</span>
                  {can('customer:credit') && (
                    <Button variant="ghost" size="sm" onClick={() => setDialog('due')}>
                      Alterar
                    </Button>
                  )}
                </div>
              )}
              {sale.cancelReason && (
                <p className="sm:col-span-4">
                  <span className="text-muted-foreground">
                    Cancelada em {sale.cancelledAt && formatDateTime(sale.cancelledAt)}:{' '}
                  </span>
                  {sale.cancelReason}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Itens</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <thead>
                  <tr>
                    <Th>Produto</Th>
                    <Th className="text-right">Qtd</Th>
                    <Th className="text-right">Unitário</Th>
                    <Th className="text-right">Desconto</Th>
                    <Th className="text-right">Devolvido</Th>
                    <Th className="text-right">Total</Th>
                  </tr>
                </thead>
                <tbody>
                  {sale.items.map((i) => (
                    <tr key={i.id}>
                      <Td>
                        {i.productName}
                        <span className="block text-xs text-muted-foreground">
                          {[i.sku, i.size, i.color].filter(Boolean).join(' · ')}
                        </span>
                      </Td>
                      <Td className="text-right tabular-nums">{i.quantity}</Td>
                      <Td className="text-right tabular-nums">{formatBRL(i.unitPriceCents)}</Td>
                      <Td className="text-right tabular-nums">
                        {i.discountCents ? formatBRL(i.discountCents) : '—'}
                      </Td>
                      <Td className="text-right tabular-nums">{i.returnedQuantity || '—'}</Td>
                      <Td className="text-right tabular-nums">{formatBRL(i.lineTotalCents)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <dl className="ml-auto mt-3 max-w-xs space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Subtotal</dt>
                  <dd className="tabular-nums">{formatBRL(sale.subtotalCents)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Desconto</dt>
                  <dd className="tabular-nums">{formatBRL(sale.discountCents)}</dd>
                </div>
                <div className="flex justify-between font-semibold">
                  <dt>Total</dt>
                  <dd className="tabular-nums">{formatBRL(sale.totalCents)}</dd>
                </div>
                {sale.returnedCents > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Devolvido</dt>
                    <dd className="tabular-nums">{formatBRL(sale.returnedCents)}</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Recebido (líquido)</dt>
                  <dd className="tabular-nums">{formatBRL(sale.receivedCents)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">A receber</dt>
                  <dd className="tabular-nums">{formatBRL(sale.balanceCents)}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Pagamentos</CardTitle>
              </CardHeader>
              <CardContent>
                {sale.payments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhum pagamento (fiado).</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {sale.payments.map((pm) => (
                      <li key={pm.id} className="flex justify-between py-2">
                        <span>
                          {pm.kind === 'estorno' ? 'Estorno · ' : ''}
                          {PAYMENT_METHOD_LABEL[pm.method]}{' '}
                          <span className="text-xs text-muted-foreground">
                            {formatDateTime(pm.createdAt)}
                          </span>
                        </span>
                        <span
                          className={
                            pm.kind === 'estorno' ? 'tabular-nums text-destructive' : 'tabular-nums'
                          }
                        >
                          {pm.kind === 'estorno' ? '− ' : ''}
                          {formatBRL(pm.amountCents)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Devoluções</CardTitle>
              </CardHeader>
              <CardContent>
                {sale.returns.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhuma devolução.</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {sale.returns.map((r) => (
                      <li key={r.id} className="py-2">
                        <div className="flex justify-between">
                          <span>
                            {formatDateTime(r.createdAt)} · {r.createdByName ?? '—'}
                          </span>
                          <span className="tabular-nums">{formatBRL(r.valueCents)}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">{r.reason}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
          <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
            {dialog === 'cancel' && <CancelDialog sale={sale} onClose={() => setDialog(null)} />}
            {dialog === 'return' && <ReturnDialog sale={sale} onClose={() => setDialog(null)} />}
            {dialog === 'due' && <DueDateDialog sale={sale} onClose={() => setDialog(null)} />}
            {dialog === 'receive' && sale.customerId && (
              <ReceiveDialog
                customerId={sale.customerId}
                customerName={sale.customerName ?? 'cliente'}
                saleId={sale.id}
                saleNumber={sale.number}
                balanceCents={sale.balanceCents}
                onClose={() => setDialog(null)}
              />
            )}
          </Dialog>
        </div>
      )}
    </>
  );
}
