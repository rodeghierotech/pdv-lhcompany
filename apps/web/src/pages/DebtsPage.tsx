import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatBRL } from '@pdv/shared';
import type { OpenDebtDTO, Paginated } from '@pdv/shared';
import { ReceiveDialog } from '@/components/ReceiveDialog';
import { ErrorNotice, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Badge, Card, Table, Td, Th } from '@/components/ui/display';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/form';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';
import { formatDateOnly, formatDateTime } from '@/lib/utils';

export function DebtsPage() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [page, setPage] = useState(1);
  const [receive, setReceive] = useState<OpenDebtDTO | null>(null);
  const query = {
    q: q.trim() || undefined,
    overdue: overdue ? 'true' : undefined,
    page,
    pageSize: 20,
  };
  const { data, error } = useQuery({
    queryKey: ['debts', query],
    queryFn: () => api<Paginated<OpenDebtDTO>>('/debts', { query }),
    placeholderData: keepPreviousData,
  });
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <>
      <PageHeader title="Fiado em aberto" />
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <Input
          aria-label="Buscar cliente"
          placeholder="Cliente"
          className="max-w-xs"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={overdue}
            onChange={(e) => {
              setOverdue(e.target.checked);
              setPage(1);
            }}
          />
          Somente vencidas
        </label>
      </div>
      <ErrorNotice error={error} />
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Cliente</Th>
              <Th>Venda</Th>
              <Th>Data</Th>
              <Th>Vencimento</Th>
              <Th className="text-right">Saldo</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data?.items.map((d) => (
              <tr key={d.saleId}>
                <Td>
                  <Link
                    className="font-medium underline-offset-2 hover:underline"
                    to={`/clientes/${d.customerId}`}
                  >
                    {d.customerName}
                  </Link>
                </Td>
                <Td>
                  <Link className="underline-offset-2 hover:underline" to={`/vendas/${d.saleId}`}>
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
                <Td className="text-right font-medium tabular-nums">{formatBRL(d.balanceCents)}</Td>
                <Td className="text-right">
                  {can('debt:receive') && (
                    <Button variant="outline" size="sm" onClick={() => setReceive(d)}>
                      Receber
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
            {data && data.items.length === 0 && (
              <tr>
                <Td colSpan={6} className="py-8 text-center text-muted-foreground">
                  Nenhuma dívida em aberto.
                </Td>
              </tr>
            )}
          </tbody>
        </Table>
      </Card>
      {data && data.total > data.pageSize && (
        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Página {page} de {totalPages}
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
      <Dialog open={receive !== null} onOpenChange={(o) => !o && setReceive(null)}>
        {receive && (
          <ReceiveDialog
            customerId={receive.customerId}
            customerName={receive.customerName}
            saleId={receive.saleId}
            saleNumber={receive.saleNumber}
            balanceCents={receive.balanceCents}
            onClose={() => setReceive(null)}
          />
        )}
      </Dialog>
    </>
  );
}
