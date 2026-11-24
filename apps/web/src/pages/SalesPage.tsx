import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatBRL, PAYMENT_STATUSES, SALE_STATUSES } from '@pdv/shared';
import type { Paginated, PaymentStatus, SaleListItemDTO, SaleStatus } from '@pdv/shared';
import {
  PaymentStatusBadge,
  PAYMENT_STATUS_LABEL,
  SALE_STATUS_LABEL,
  SaleStatusBadge,
} from '@/components/SaleBadges';
import { ErrorNotice, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, Table, Td, Th } from '@/components/ui/display';
import { Input, Select } from '@/components/ui/form';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

export function SalesPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<SaleStatus | ''>('');
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const query = {
    q: q.trim() || undefined,
    status: status || undefined,
    paymentStatus: paymentStatus || undefined,
    from: from || undefined,
    to: to || undefined,
    page,
    pageSize: 20,
  };
  const { data, error } = useQuery({
    queryKey: ['sales', query],
    queryFn: () => api<Paginated<SaleListItemDTO>>('/sales', { query }),
    placeholderData: keepPreviousData,
  });
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const reset =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(1);
    };

  return (
    <>
      <PageHeader title="Vendas" />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Input
          aria-label="Buscar venda"
          placeholder="Nº ou cliente"
          value={q}
          onChange={(e) => reset(setQ)(e.target.value)}
        />
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => reset(setStatus)(e.target.value as SaleStatus | '')}
        >
          <option value="">Todos os status</option>
          {SALE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {SALE_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Pagamento"
          value={paymentStatus}
          onChange={(e) => reset(setPaymentStatus)(e.target.value as PaymentStatus | '')}
        >
          <option value="">Todos os pagamentos</option>
          {PAYMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PAYMENT_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Input
          aria-label="De"
          type="date"
          value={from}
          onChange={(e) => reset(setFrom)(e.target.value)}
        />
        <Input
          aria-label="Até"
          type="date"
          value={to}
          onChange={(e) => reset(setTo)(e.target.value)}
        />
      </div>
      <ErrorNotice error={error} />
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Nº</Th>
              <Th>Data</Th>
              <Th>Cliente</Th>
              <Th>Vendedor</Th>
              <Th>Status</Th>
              <Th>Pagamento</Th>
              <Th className="text-right">Total</Th>
              <Th className="text-right">A receber</Th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((s) => (
              <tr key={s.id} className="hover:bg-accent/50">
                <Td>
                  <Link
                    className="font-medium underline-offset-2 hover:underline"
                    to={`/vendas/${s.id}`}
                  >
                    #{s.number}
                  </Link>
                </Td>
                <Td>{formatDateTime(s.createdAt)}</Td>
                <Td>{s.customerName ?? '—'}</Td>
                <Td>{s.sellerName}</Td>
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
            {data && data.items.length === 0 && (
              <tr>
                <Td colSpan={8} className="py-8 text-center text-muted-foreground">
                  Nenhuma venda encontrada.
                </Td>
              </tr>
            )}
          </tbody>
        </Table>
      </Card>
      {data && data.total > data.pageSize && (
        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Página {page} de {totalPages} · {data.total} vendas
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
    </>
  );
}
