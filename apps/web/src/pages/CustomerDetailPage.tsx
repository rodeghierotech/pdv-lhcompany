import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { formatBRL, PAYMENT_METHOD_LABEL } from '@pdv/shared';
import type {
  CustomerAccountDTO,
  CustomerPaymentDTO,
  DebtReceiptDTO,
  OpenDebtDTO,
  Paginated,
  SaleListItemDTO,
} from '@pdv/shared';
import { invalidateFinance, ReceiveDialog } from '@/components/ReceiveDialog';
import { PaymentStatusBadge, SaleStatusBadge } from '@/components/SaleBadges';
import { ErrorNotice, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  Td,
  Th,
} from '@/components/ui/display';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';
import { formatDateOnly, formatDateTime, newIdempotencyKey } from '@/lib/utils';
import { CustomerFormDialog } from '@/pages/CustomersPage';

function ReverseReceiptDialog({
  receipt,
  onClose,
}: {
  receipt: DebtReceiptDTO;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const key = useRef(newIdempotencyKey());
  const reverse = useMutation({
    mutationFn: () =>
      api(`/receipts/${receipt.id}/reverse`, {
        method: 'POST',
        body: { reason: reason.trim(), idempotencyKey: key.current },
      }),
    onSuccess: () => {
      toast.success(`Recebimento #${receipt.number} estornado`);
      invalidateFinance(queryClient);
      onClose();
    },
  });
  return (
    <DialogContent
      title={`Estornar recebimento #${receipt.number}`}
      description={`${formatBRL(receipt.totalCents)} voltam para a dívida do cliente; o registro original é mantido e a saída é lançada no seu caixa.`}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim().length >= 3) reverse.mutate();
        }}
      >
        <Field label="Motivo *" htmlFor="rr-reason">
          <Input
            id="rr-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
        </Field>
        <ErrorNotice error={reverse.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={reason.trim().length < 3 || reverse.isPending}
          >
            Confirmar estorno
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

const ORIGIN_LABEL = {
  venda: 'Na venda',
  posterior: 'Recebimento posterior',
  estorno: 'Estorno',
} as const;

export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [receive, setReceive] = useState<{ sale?: OpenDebtDTO } | null>(null);
  const [reversing, setReversing] = useState<DebtReceiptDTO | null>(null);

  const account = useQuery({
    queryKey: ['customer-account', id],
    queryFn: () => api<CustomerAccountDTO>(`/customers/${id}/account`),
  });
  const payments = useQuery({
    queryKey: ['customer-payments', id],
    queryFn: () =>
      api<Paginated<CustomerPaymentDTO>>(`/customers/${id}/payments`, { query: { pageSize: 20 } }),
  });
  const purchases = useQuery({
    queryKey: ['sales', { customerId: id }],
    queryFn: () =>
      api<Paginated<SaleListItemDTO>>('/sales', { query: { customerId: id, pageSize: 10 } }),
  });

  const a = account.data;
  const c = a?.customer;
  const balance = a?.openDebts.reduce((s, d) => s + d.balanceCents, 0) ?? 0;
  const available =
    c && c.creditLimitCents !== null ? Math.max(c.creditLimitCents - c.debtCents, 0) : null;
  const canReceive = can('debt:receive');

  return (
    <>
      <PageHeader
        title={c?.name ?? 'Cliente'}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/clientes">
                <ArrowLeft /> Clientes
              </Link>
            </Button>
            {c && can('customer:write') && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                Editar
              </Button>
            )}
            {c && canReceive && balance > 0 && (
              <Button onClick={() => setReceive({})}>Receber do saldo</Button>
            )}
          </>
        }
      />
      <ErrorNotice error={account.error} />
      {a && c && (
        <div className="space-y-4">
          <Card>
            <CardContent className="grid gap-3 pt-4 text-sm sm:grid-cols-5 sm:pt-5">
              <div>
                <p className="text-muted-foreground">Contato</p>
                <p>{c.phone ?? '—'}</p>
                <p className="text-xs text-muted-foreground">{c.document ?? ''}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Saldo devedor</p>
                <p className="text-lg font-semibold tabular-nums" data-testid="customer-debt">
                  {formatBRL(c.debtCents)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Vencido</p>
                <p
                  className={`tabular-nums ${a.overdueCents > 0 ? 'font-semibold text-destructive' : ''}`}
                >
                  {formatBRL(a.overdueCents)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Limite de crédito</p>
                <p className="tabular-nums">
                  {c.creditLimitCents === null ? 'Sem limite' : formatBRL(c.creditLimitCents)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Crédito disponível</p>
                <p className="tabular-nums">{available === null ? '—' : formatBRL(available)}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Dívidas em aberto</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <thead>
                  <tr>
                    <Th>Venda</Th>
                    <Th>Data</Th>
                    <Th>Vencimento</Th>
                    <Th className="text-right">Total</Th>
                    <Th className="text-right">Recebido</Th>
                    <Th className="text-right">Saldo</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {a.openDebts.map((d) => (
                    <tr key={d.saleId}>
                      <Td>
                        <Link
                          className="underline-offset-2 hover:underline"
                          to={`/vendas/${d.saleId}`}
                        >
                          #{d.saleNumber}
                        </Link>
                      </Td>
                      <Td>{formatDateTime(d.createdAt)}</Td>
                      <Td>
                        {d.dueDate ? formatDateOnly(d.dueDate) : '—'}
                        {d.overdue && (
                          <Badge variant="destructive" className="ml-2">
                            Vencida
                          </Badge>
                        )}
                      </Td>
                      <Td className="text-right tabular-nums">{formatBRL(d.totalCents)}</Td>
                      <Td className="text-right tabular-nums">{formatBRL(d.receivedCents)}</Td>
                      <Td className="text-right font-medium tabular-nums">
                        {formatBRL(d.balanceCents)}
                      </Td>
                      <Td className="text-right">
                        {canReceive && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setReceive({ sale: d })}
                          >
                            Receber
                          </Button>
                        )}
                      </Td>
                    </tr>
                  ))}
                  {a.openDebts.length === 0 && (
                    <tr>
                      <Td colSpan={7} className="py-6 text-center text-muted-foreground">
                        Sem dívidas em aberto.
                      </Td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Recebimentos de fiado</CardTitle>
              </CardHeader>
              <CardContent>
                {a.receipts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhum recebimento posterior.</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {a.receipts.map((r) => (
                      <li key={r.id} className="flex items-start justify-between gap-3 py-2">
                        <div>
                          <p>
                            {r.kind === 'estorno' ? 'Estorno' : 'Recebimento'} #{r.number} ·{' '}
                            {formatDateTime(r.createdAt)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {r.createdByName} ·{' '}
                            {r.allocations
                              .map(
                                (al) =>
                                  `venda #${al.saleNumber} ${PAYMENT_METHOD_LABEL[al.method]} ${formatBRL(al.amountCents)}`,
                              )
                              .join('; ')}
                            {r.reason ? ` · ${r.reason}` : ''}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span
                            className={`tabular-nums ${r.kind === 'estorno' ? 'text-destructive' : ''}`}
                          >
                            {r.kind === 'estorno' ? '− ' : ''}
                            {formatBRL(r.totalCents)}
                          </span>
                          {r.kind === 'recebimento' &&
                            (r.reversed ? (
                              <Badge variant="secondary">Estornado</Badge>
                            ) : (
                              can('debt:reverse') && (
                                <Button variant="ghost" size="sm" onClick={() => setReversing(r)}>
                                  Estornar
                                </Button>
                              )
                            ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Histórico de pagamentos</CardTitle>
              </CardHeader>
              <CardContent>
                <ErrorNotice error={payments.error} />
                <Table>
                  <thead>
                    <tr>
                      <Th>Data</Th>
                      <Th>Venda</Th>
                      <Th>Origem</Th>
                      <Th>Forma</Th>
                      <Th className="text-right">Valor</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.data?.items.map((p) => (
                      <tr key={p.id}>
                        <Td className="whitespace-nowrap">{formatDateTime(p.createdAt)}</Td>
                        <Td>
                          <Link
                            className="underline-offset-2 hover:underline"
                            to={`/vendas/${p.saleId}`}
                          >
                            #{p.saleNumber}
                          </Link>
                        </Td>
                        <Td>{ORIGIN_LABEL[p.origin]}</Td>
                        <Td>{PAYMENT_METHOD_LABEL[p.method]}</Td>
                        <Td
                          className={`text-right tabular-nums ${p.kind === 'estorno' ? 'text-destructive' : ''}`}
                        >
                          {p.kind === 'estorno' ? '− ' : ''}
                          {formatBRL(p.amountCents)}
                        </Td>
                      </tr>
                    ))}
                    {payments.data && payments.data.items.length === 0 && (
                      <tr>
                        <Td colSpan={5} className="py-6 text-center text-muted-foreground">
                          Sem pagamentos.
                        </Td>
                      </tr>
                    )}
                  </tbody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Histórico de compras</CardTitle>
            </CardHeader>
            <CardContent>
              <ErrorNotice error={purchases.error} />
              <Table>
                <thead>
                  <tr>
                    <Th>Nº</Th>
                    <Th>Data</Th>
                    <Th>Status</Th>
                    <Th>Pagamento</Th>
                    <Th className="text-right">Total</Th>
                    <Th className="text-right">A receber</Th>
                  </tr>
                </thead>
                <tbody>
                  {purchases.data?.items.map((s) => (
                    <tr key={s.id}>
                      <Td>
                        <Link className="underline-offset-2 hover:underline" to={`/vendas/${s.id}`}>
                          #{s.number}
                        </Link>
                      </Td>
                      <Td>{formatDateTime(s.createdAt)}</Td>
                      <Td>
                        <SaleStatusBadge status={s.status} />
                      </Td>
                      <Td>
                        <PaymentStatusBadge status={s.paymentStatus} />
                      </Td>
                      <Td className="text-right tabular-nums">{formatBRL(s.totalCents)}</Td>
                      <Td className="text-right tabular-nums">
                        {s.balanceCents > 0 ? formatBRL(s.balanceCents) : '—'}
                      </Td>
                    </tr>
                  ))}
                  {purchases.data && purchases.data.items.length === 0 && (
                    <tr>
                      <Td colSpan={6} className="py-6 text-center text-muted-foreground">
                        Sem compras.
                      </Td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </CardContent>
          </Card>

          <Dialog open={editing} onOpenChange={setEditing}>
            {editing && <CustomerFormDialog customer={c} onClose={() => setEditing(false)} />}
          </Dialog>
          <Dialog open={receive !== null} onOpenChange={(o) => !o && setReceive(null)}>
            {receive && (
              <ReceiveDialog
                customerId={c.id}
                customerName={c.name}
                {...(receive.sale
                  ? { saleId: receive.sale.saleId, saleNumber: receive.sale.saleNumber }
                  : {})}
                balanceCents={receive.sale ? receive.sale.balanceCents : balance}
                onClose={() => setReceive(null)}
              />
            )}
          </Dialog>
          <Dialog open={reversing !== null} onOpenChange={(o) => !o && setReversing(null)}>
            {reversing && (
              <ReverseReceiptDialog receipt={reversing} onClose={() => setReversing(null)} />
            )}
          </Dialog>
        </div>
      )}
    </>
  );
}
