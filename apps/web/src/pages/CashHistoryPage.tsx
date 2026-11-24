import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatBRL } from '@pdv/shared';
import type { CashSessionDTO, Paginated } from '@pdv/shared';
import { SessionPanel } from '@/components/CashSessionView';
import { ErrorNotice, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Badge, Card, Table, Td, Th } from '@/components/ui/display';
import { Input, Select } from '@/components/ui/form';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

export function CashHistoryPage() {
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const query = {
    status: status || undefined,
    from: from || undefined,
    to: to || undefined,
    page,
    pageSize: 20,
  };
  const { data, error } = useQuery({
    queryKey: ['cash', 'sessions', query],
    queryFn: () => api<Paginated<CashSessionDTO>>('/cash/sessions', { query }),
    placeholderData: keepPreviousData,
  });
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <>
      <PageHeader
        title="Histórico de caixas"
        actions={
          <Button variant="outline" asChild>
            <Link to="/caixa">Caixa atual</Link>
          </Button>
        }
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Todos</option>
          <option value="aberto">Abertos</option>
          <option value="fechado">Fechados</option>
        </Select>
        <Input
          aria-label="De"
          type="date"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setPage(1);
          }}
        />
        <Input
          aria-label="Até"
          type="date"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setPage(1);
          }}
        />
      </div>
      <ErrorNotice error={error} />
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Nº</Th>
              <Th>Operador</Th>
              <Th>Abertura</Th>
              <Th>Fechamento</Th>
              <Th>Status</Th>
              <Th className="text-right">Esperado</Th>
              <Th className="text-right">Contado</Th>
              <Th className="text-right">Diferença</Th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((s) => (
              <tr key={s.id} className="hover:bg-accent/50">
                <Td>
                  <Link
                    className="font-medium underline-offset-2 hover:underline"
                    to={`/caixa/sessoes/${s.id}`}
                  >
                    #{s.number}
                  </Link>
                </Td>
                <Td>{s.openedByName}</Td>
                <Td>{formatDateTime(s.openedAt)}</Td>
                <Td>{s.closedAt ? formatDateTime(s.closedAt) : '—'}</Td>
                <Td>
                  <Badge variant={s.status === 'aberto' ? 'success' : 'secondary'}>
                    {s.status === 'aberto' ? 'Aberto' : 'Fechado'}
                  </Badge>
                </Td>
                <Td className="text-right tabular-nums">
                  {s.expectedCents === null ? '—' : formatBRL(s.expectedCents)}
                </Td>
                <Td className="text-right tabular-nums">
                  {s.countedCents === null ? '—' : formatBRL(s.countedCents)}
                </Td>
                <Td
                  className={`text-right tabular-nums ${s.differenceCents ? 'font-semibold text-destructive' : ''}`}
                >
                  {s.differenceCents === null ? '—' : formatBRL(s.differenceCents)}
                </Td>
              </tr>
            ))}
            {data && data.items.length === 0 && (
              <tr>
                <Td colSpan={8} className="py-8 text-center text-muted-foreground">
                  Nenhum caixa encontrado.
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
    </>
  );
}

export function CashSessionPage() {
  const { id } = useParams();
  return (
    <>
      <PageHeader
        title="Detalhe do caixa"
        actions={
          <Button variant="outline" asChild>
            <Link to="/caixa/historico">Histórico</Link>
          </Button>
        }
      />
      {id && <SessionPanel sessionId={id} live={false} />}
    </>
  );
}
