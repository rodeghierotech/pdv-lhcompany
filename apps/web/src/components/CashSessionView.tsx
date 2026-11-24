import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { formatBRL, PAYMENT_METHOD_LABEL } from '@pdv/shared';
import type {
  CashMovementKind,
  CashReportDTO,
  CashSessionDTO,
  LedgerEntryDTO,
  LedgerEntryType,
  Paginated,
} from '@pdv/shared';
import { ErrorNotice } from '@/components/shared';
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
import { Field, Input, Select } from '@/components/ui/form';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';
import { formatDateTime, newIdempotencyKey } from '@/lib/utils';
import { centsToInput } from '@/lib/variantForm';
import { parseBRLToCents } from '@pdv/shared';

export const LEDGER_LABEL: Record<LedgerEntryType, string> = {
  abertura: 'Abertura',
  recebimento_venda: 'Recebimento de venda',
  recebimento_fiado: 'Recebimento de fiado',
  estorno_pagamento: 'Estorno de pagamento',
  estorno_recebimento: 'Estorno de recebimento',
  sangria: 'Sangria',
  suprimento: 'Suprimento',
  despesa: 'Despesa',
  estorno_movimento: 'Estorno de movimento',
};

const MOVEMENT_LABEL: Record<CashMovementKind, string> = {
  sangria: 'Sangria',
  suprimento: 'Suprimento',
  despesa: 'Despesa',
};

export function invalidateCash(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ['cash'] });
}

function Row({
  label,
  value,
  strong,
  negative,
}: {
  label: string;
  value: string;
  strong?: boolean;
  negative?: boolean;
}) {
  return (
    <div className={`flex justify-between ${strong ? 'border-t pt-2 font-semibold' : ''}`}>
      <dt className={strong ? '' : 'text-muted-foreground'}>{label}</dt>
      <dd className={`tabular-nums ${negative ? 'text-destructive' : ''}`}>{value}</dd>
    </div>
  );
}

/** Fechamento: separa faturamento (competência) de recebimento (caixa) e mostra só o dinheiro esperado na gaveta. */
export function CashReport({ report }: { report: CashReportDTO }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>Dinheiro na gaveta</CardTitle>
          <p className="text-xs text-muted-foreground">PIX, débito e crédito não entram aqui.</p>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-3xl font-semibold tabular-nums" data-testid="expected-cash">
            {formatBRL(report.expectedCashCents)}
          </p>
          <dl className="space-y-1 text-sm">
            <Row label="Saldo inicial" value={formatBRL(report.openingCents)} />
            <Row
              label="Dinheiro recebido (líquido)"
              value={formatBRL(report.byMethod.find((m) => m.method === 'dinheiro')?.netCents ?? 0)}
            />
            <Row label="Suprimentos" value={formatBRL(report.suprimentoCents)} />
            <Row
              label="Sangrias"
              value={`− ${formatBRL(report.sangriaCents)}`}
              negative={report.sangriaCents > 0}
            />
            <Row
              label="Despesas"
              value={`− ${formatBRL(report.despesaCents)}`}
              negative={report.despesaCents > 0}
            />
            {report.movementReversalsCents !== 0 && (
              <Row
                label="Estornos de movimentos"
                value={formatBRL(report.movementReversalsCents)}
              />
            )}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Faturamento</CardTitle>
          <p className="text-xs text-muted-foreground">Vendas feitas neste caixa, pagas ou não.</p>
        </CardHeader>
        <CardContent>
          <dl className="space-y-1 text-sm">
            <Row
              label={`Vendas (${report.salesCount})`}
              value={formatBRL(report.salesTotalCents)}
            />
            <Row
              label={`Canceladas (${report.cancelledCount})`}
              value={formatBRL(report.cancelledCents)}
            />
            <Row
              label={`Devoluções (${report.returnsCount})`}
              value={formatBRL(report.returnsCents)}
            />
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recebimentos efetivos</CardTitle>
          <p className="text-xs text-muted-foreground">O que de fato entrou, por modalidade.</p>
        </CardHeader>
        <CardContent>
          <Table>
            <thead>
              <tr>
                <Th>Forma</Th>
                <Th className="text-right">Recebido</Th>
                <Th className="text-right">Estornado</Th>
                <Th className="text-right">Líquido</Th>
              </tr>
            </thead>
            <tbody>
              {report.byMethod.map((m) => (
                <tr key={m.method}>
                  <Td>{PAYMENT_METHOD_LABEL[m.method]}</Td>
                  <Td className="text-right tabular-nums">{formatBRL(m.receivedCents)}</Td>
                  <Td className="text-right tabular-nums">{formatBRL(m.refundedCents)}</Td>
                  <Td className="text-right tabular-nums">{formatBRL(m.netCents)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <dl className="mt-3 space-y-1 text-sm">
            <Row label="De vendas" value={formatBRL(report.receivedSalesCents)} />
            <Row label="De fiado" value={formatBRL(report.receivedDebtCents)} />
            <Row label="Estornos/reembolsos" value={`− ${formatBRL(report.refundedCents)}`} />
            <Row label="Total líquido" value={formatBRL(report.receivedNetCents)} strong />
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

const REVERSIBLE: LedgerEntryType[] = ['sangria', 'suprimento', 'despesa'];

function ReverseMovementDialog({ entry, onClose }: { entry: LedgerEntryDTO; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const key = useRef(newIdempotencyKey());
  const reverse = useMutation({
    mutationFn: () =>
      api(`/cash/movements/${entry.id}/reverse`, {
        method: 'POST',
        body: { reason: reason.trim(), idempotencyKey: key.current },
      }),
    onSuccess: () => {
      toast.success('Movimento estornado');
      invalidateCash(queryClient);
      onClose();
    },
  });
  return (
    <DialogContent
      title={`Estornar ${LEDGER_LABEL[entry.type].toLowerCase()}`}
      description={`${formatBRL(entry.amountCents)} — o registro original é mantido e um estorno é lançado no seu caixa.`}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim().length >= 3) reverse.mutate();
        }}
      >
        <Field label="Motivo *" htmlFor="reverse-reason">
          <Input
            id="reverse-reason"
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
          <Button type="submit" disabled={reason.trim().length < 3 || reverse.isPending}>
            Confirmar estorno
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

export function Ledger({ sessionId, canReverse }: { sessionId: string; canReverse: boolean }) {
  const [page, setPage] = useState(1);
  const [reversing, setReversing] = useState<LedgerEntryDTO | null>(null);
  const { data, error } = useQuery({
    queryKey: ['cash', 'ledger', sessionId, page],
    queryFn: () =>
      api<Paginated<LedgerEntryDTO>>(`/cash/sessions/${sessionId}/movements`, {
        query: { page, pageSize: 25 },
      }),
    placeholderData: keepPreviousData,
  });
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Movimentações</CardTitle>
      </CardHeader>
      <CardContent>
        <ErrorNotice error={error} />
        <Table>
          <thead>
            <tr>
              <Th>Hora</Th>
              <Th>Tipo</Th>
              <Th>Referência</Th>
              <Th>Operador</Th>
              <Th>Forma</Th>
              <Th>Gaveta</Th>
              <Th className="text-right">Valor</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data?.items.map((e) => (
              <tr key={`${e.type}-${e.id}`}>
                <Td className="whitespace-nowrap">{formatDateTime(e.at)}</Td>
                <Td>{LEDGER_LABEL[e.type]}</Td>
                <Td>
                  {e.saleId && (
                    <Link className="underline-offset-2 hover:underline" to={`/vendas/${e.saleId}`}>
                      Venda #{e.saleNumber}
                    </Link>
                  )}
                  {e.customerName && (
                    <span className="text-muted-foreground"> {e.customerName}</span>
                  )}
                  {e.description && (
                    <span className="block text-xs text-muted-foreground">{e.description}</span>
                  )}
                </Td>
                <Td>{e.operatorName ?? '—'}</Td>
                <Td>{e.method ? PAYMENT_METHOD_LABEL[e.method] : '—'}</Td>
                <Td>
                  {e.cashEffect === 'entrada' ? (
                    <Badge variant="success">Entra</Badge>
                  ) : e.cashEffect === 'saida' ? (
                    <Badge variant="destructive">Sai</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </Td>
                <Td className="text-right tabular-nums">{formatBRL(e.amountCents)}</Td>
                <Td>
                  {canReverse &&
                    REVERSIBLE.includes(e.type) &&
                    (e.reversed ? (
                      <Badge variant="secondary">Estornado</Badge>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => setReversing(e)}>
                        Estornar
                      </Button>
                    ))}
                </Td>
              </tr>
            ))}
            {data && data.items.length === 0 && (
              <tr>
                <Td colSpan={8} className="py-6 text-center text-muted-foreground">
                  Sem movimentações.
                </Td>
              </tr>
            )}
          </tbody>
        </Table>
        {data && data.total > data.pageSize && (
          <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
            <span>
              Página {page} de {totalPages} · {data.total} registros
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Anterior
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                Próxima
              </Button>
            </div>
          </div>
        )}
      </CardContent>
      <Dialog open={reversing !== null} onOpenChange={(o) => !o && setReversing(null)}>
        {reversing && (
          <ReverseMovementDialog entry={reversing} onClose={() => setReversing(null)} />
        )}
      </Dialog>
    </Card>
  );
}

export function MovementDialog({ kind, onClose }: { kind: CashMovementKind; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [type, setType] = useState<CashMovementKind>(kind);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const key = useRef(newIdempotencyKey());
  const cents = amount.trim() ? parseBRLToCents(amount) : null;
  const save = useMutation({
    mutationFn: () =>
      api('/cash/movements', {
        method: 'POST',
        body: {
          idempotencyKey: key.current,
          kind: type,
          amountCents: cents,
          description: description.trim(),
          ...(category.trim() ? { category: category.trim() } : {}),
        },
      }),
    onSuccess: () => {
      toast.success(`${MOVEMENT_LABEL[type]} registrada`);
      invalidateCash(queryClient);
      onClose();
    },
  });
  const valid = cents !== null && cents > 0 && description.trim().length >= 3;
  return (
    <DialogContent
      title="Movimento de caixa"
      description="Sangria e despesa tiram dinheiro da gaveta; suprimento coloca."
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <Field label="Tipo" htmlFor="mov-kind">
          <Select
            id="mov-kind"
            value={type}
            onChange={(e) => setType(e.target.value as CashMovementKind)}
          >
            {(Object.keys(MOVEMENT_LABEL) as CashMovementKind[]).map((k) => (
              <option key={k} value={k}>
                {MOVEMENT_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Valor *" htmlFor="mov-amount">
          <Input
            id="mov-amount"
            inputMode="decimal"
            placeholder="0,00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Descrição *" htmlFor="mov-desc">
          <Input
            id="mov-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        {type === 'despesa' && (
          <Field label="Categoria" htmlFor="mov-cat">
            <Input id="mov-cat" value={category} onChange={(e) => setCategory(e.target.value)} />
          </Field>
        )}
        <ErrorNotice error={save.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button type="submit" disabled={!valid || save.isPending}>
            Registrar
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

export function CloseDialog({
  session,
  report,
  onClose,
}: {
  session: CashSessionDTO;
  report: CashReportDTO;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const key = useRef(newIdempotencyKey());
  const cents = counted.trim() ? parseBRLToCents(counted) : null;
  const diff = cents === null ? null : cents - report.expectedCashCents;
  const close = useMutation({
    mutationFn: () =>
      api(`/cash/sessions/${session.id}/close`, {
        method: 'POST',
        body: {
          idempotencyKey: key.current,
          countedCents: cents,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      }),
    onSuccess: () => {
      toast.success(`Caixa #${session.number} fechado`);
      invalidateCash(queryClient);
      onClose();
    },
  });
  const needsNote = diff !== null && diff !== 0;
  const valid = cents !== null && (!needsNote || note.trim().length >= 3);
  return (
    <DialogContent
      title={`Fechar caixa #${session.number}`}
      description="Conte o dinheiro da gaveta. PIX e cartões não entram na conferência."
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) close.mutate();
        }}
      >
        <div className="flex justify-between rounded-md bg-muted px-3 py-2 text-sm">
          <span>Esperado em dinheiro</span>
          <strong className="tabular-nums">{formatBRL(report.expectedCashCents)}</strong>
        </div>
        <Field
          label="Valor contado *"
          htmlFor="close-counted"
          hint={counted ? undefined : centsToInput(report.expectedCashCents)}
        >
          <Input
            id="close-counted"
            inputMode="decimal"
            placeholder="0,00"
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
            autoFocus
          />
        </Field>
        {diff !== null && (
          <p
            role="status"
            data-testid="close-difference"
            className={diff === 0 ? 'text-sm text-success' : 'text-sm font-medium text-destructive'}
          >
            {diff === 0
              ? 'Caixa conferido, sem diferença.'
              : `${diff > 0 ? 'Sobra' : 'Falta'} de ${formatBRL(Math.abs(diff))}`}
          </p>
        )}
        {needsNote && (
          <Field label="Justificativa da diferença *" htmlFor="close-note">
            <Input id="close-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
        <ErrorNotice error={close.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button type="submit" disabled={!valid || close.isPending}>
            Fechar caixa
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

export function SessionHeader({ session }: { session: CashSessionDTO }) {
  return (
    <Card>
      <CardContent className="grid gap-3 pt-4 text-sm sm:grid-cols-4 sm:pt-5">
        <div>
          <p className="text-muted-foreground">Caixa</p>
          <p className="flex items-center gap-2">
            #{session.number}{' '}
            <Badge variant={session.status === 'aberto' ? 'success' : 'secondary'}>
              {session.status === 'aberto' ? 'Aberto' : 'Fechado'}
            </Badge>
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Operador</p>
          <p>{session.openedByName}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Aberto em</p>
          <p>{formatDateTime(session.openedAt)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Saldo inicial</p>
          <p className="tabular-nums">{formatBRL(session.openingCents)}</p>
        </div>
        {session.status === 'fechado' && session.closedAt && (
          <>
            <div>
              <p className="text-muted-foreground">Fechado por</p>
              <p>
                {session.closedByName} · {formatDateTime(session.closedAt)}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Esperado</p>
              <p className="tabular-nums">{formatBRL(session.expectedCents ?? 0)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Contado</p>
              <p className="tabular-nums">{formatBRL(session.countedCents ?? 0)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Diferença</p>
              <p
                className={`tabular-nums ${session.differenceCents ? 'font-semibold text-destructive' : ''}`}
                data-testid="session-difference"
              >
                {formatBRL(session.differenceCents ?? 0)}
              </p>
            </div>
            {session.closeNote && (
              <p className="sm:col-span-4">
                <span className="text-muted-foreground">Justificativa: </span>
                {session.closeNote}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Painel completo de um caixa (aberto ou histórico). */
export function SessionPanel({ sessionId, live }: { sessionId: string; live: boolean }) {
  const { can } = useAuth();
  const [dialog, setDialog] = useState<CashMovementKind | 'close' | null>(null);
  const { data, error } = useQuery({
    queryKey: ['cash', 'session', sessionId],
    queryFn: () =>
      api<{ session: CashSessionDTO; report: CashReportDTO }>(`/cash/sessions/${sessionId}`),
  });
  return (
    <div className="space-y-4">
      <ErrorNotice error={error} />
      {data && (
        <>
          <SessionHeader session={data.session} />
          {live && data.session.status === 'aberto' && (
            <div className="flex flex-wrap gap-2">
              {can('cash:movement') && (
                <>
                  <Button variant="outline" onClick={() => setDialog('sangria')}>
                    Sangria
                  </Button>
                  <Button variant="outline" onClick={() => setDialog('suprimento')}>
                    Suprimento
                  </Button>
                  <Button variant="outline" onClick={() => setDialog('despesa')}>
                    Despesa
                  </Button>
                </>
              )}
              {can('cash:close') && (
                <Button className="ml-auto" onClick={() => setDialog('close')}>
                  Fechar caixa
                </Button>
              )}
            </div>
          )}
          <CashReport report={data.report} />
          <Ledger
            sessionId={sessionId}
            canReverse={live && data.session.status === 'aberto' && can('cash:manage')}
          />
          <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
            {dialog === 'close' ? (
              <CloseDialog
                session={data.session}
                report={data.report}
                onClose={() => setDialog(null)}
              />
            ) : dialog ? (
              <MovementDialog kind={dialog} onClose={() => setDialog(null)} />
            ) : null}
          </Dialog>
        </>
      )}
    </div>
  );
}
