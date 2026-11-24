import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { formatBRL, PAYMENT_METHOD_LABEL } from '@pdv/shared';
import type {
  DailyPointDTO,
  RecentMovementDTO,
  ReportSummaryDTO,
  SellerReportDTO,
  TopProductDTO,
} from '@pdv/shared';
import { DailyChart } from '@/components/DailyChart';
import { LEDGER_LABEL } from '@/components/CashSessionView';
import { ErrorNotice, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Table, Td, Th } from '@/components/ui/display';
import { Input } from '@/components/ui/form';
import { api, apiDownload } from '@/lib/api';
import { describeApiError } from '@/lib/errors';
import { PERIOD_LABEL, presetRange } from '@/lib/periods';
import type { PeriodPreset } from '@/lib/periods';
import { formatDateOnly, formatDateTime } from '@/lib/utils';

function Kpi({
  label,
  value,
  sub,
  testId,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  testId: string;
  tone?: 'warning' | 'destructive';
}) {
  return (
    <Card>
      <CardContent className="pt-4 sm:pt-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p
          className={`text-2xl font-semibold tabular-nums ${tone === 'destructive' ? 'text-destructive' : tone === 'warning' ? 'text-warning' : ''}`}
          data-testid={testId}
        >
          {value}
        </p>
        {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const [preset, setPreset] = useState<PeriodPreset | 'custom'>('hoje');
  const [range, setRange] = useState(() => presetRange('hoje'));
  const valid = range.from !== '' && range.to !== '' && range.from <= range.to;
  const query = valid ? range : null;

  const summary = useQuery({
    queryKey: ['reports', 'summary', query],
    queryFn: () => api<{ summary: ReportSummaryDTO }>('/reports/summary', { query: query! }),
    enabled: !!query,
  });
  const daily = useQuery({
    queryKey: ['reports', 'daily', query],
    queryFn: () => api<{ items: DailyPointDTO[] }>('/reports/daily', { query: query! }),
    enabled: !!query,
  });
  const top = useQuery({
    queryKey: ['reports', 'top', query],
    queryFn: () =>
      api<{ items: TopProductDTO[] }>('/reports/top-products', { query: { ...query!, limit: 10 } }),
    enabled: !!query,
  });
  const sellers = useQuery({
    queryKey: ['reports', 'sellers', query],
    queryFn: () => api<{ items: SellerReportDTO[] }>('/reports/sellers', { query: query! }),
    enabled: !!query,
  });
  const recent = useQuery({
    queryKey: ['reports', 'recent'],
    queryFn: () => api<{ items: RecentMovementDTO[] }>('/reports/recent'),
    refetchInterval: 30_000,
  });

  const s = summary.data?.summary;
  const choose = (p: PeriodPreset) => {
    setPreset(p);
    setRange(presetRange(p));
  };
  const exportCsv = async (kind: 'sales' | 'payments') => {
    if (!query) return;
    try {
      await apiDownload(`/reports/${kind}.csv`, query, `${kind}.csv`);
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Painel"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={!query}
              onClick={() => void exportCsv('sales')}
            >
              <Download /> Vendas (CSV)
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!query}
              onClick={() => void exportCsv('payments')}
            >
              <Download /> Pagamentos (CSV)
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-2">
        {(Object.keys(PERIOD_LABEL) as PeriodPreset[]).map((p) => (
          <Button
            key={p}
            size="sm"
            variant={preset === p ? 'default' : 'outline'}
            onClick={() => choose(p)}
          >
            {PERIOD_LABEL[p]}
          </Button>
        ))}
        <div className="flex items-center gap-2">
          <Input
            aria-label="De"
            type="date"
            className="h-9 w-40"
            value={range.from}
            onChange={(e) => {
              setPreset('custom');
              setRange({ ...range, from: e.target.value });
            }}
          />
          <Input
            aria-label="Até"
            type="date"
            className="h-9 w-40"
            value={range.to}
            onChange={(e) => {
              setPreset('custom');
              setRange({ ...range, to: e.target.value });
            }}
          />
        </div>
      </div>
      {!valid && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          Período inválido: o fim deve ser igual ou posterior ao início.
        </p>
      )}
      <ErrorNotice error={summary.error ?? daily.error ?? top.error ?? sellers.error} />

      {s && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 [&>*]:min-w-0">
            <Kpi
              testId="kpi-net-sales"
              label="Faturamento líquido"
              value={formatBRL(s.sales.netCents)}
              sub={`Bruto ${formatBRL(s.sales.grossCents)} − cancel. ${formatBRL(s.sales.cancelledCents)} − devol. ${formatBRL(s.sales.returnsCents)}`}
            />
            <Kpi
              testId="kpi-received"
              label="Recebido (líquido)"
              value={formatBRL(s.receipts.netCents)}
              sub={`Vendas ${formatBRL(s.receipts.salesCents)} · fiado ${formatBRL(s.receipts.debtCents)} · estornos −${formatBRL(s.receipts.refundedCents)}`}
            />
            <Kpi
              testId="kpi-count"
              label="Vendas · ticket médio"
              value={`${s.sales.validCount} · ${formatBRL(s.sales.ticketAverageCents)}`}
              sub={`${s.sales.count - s.sales.validCount} cancelada(s) · desconto ${formatBRL(s.sales.discountCents)}`}
            />
            <Kpi
              testId="kpi-open-debts"
              label="Em aberto (fiado)"
              value={formatBRL(s.openDebts.totalCents)}
              tone={s.openDebts.overdueCents > 0 ? 'warning' : undefined}
              sub={`${s.openDebts.customersCount} cliente(s) · vencido ${formatBRL(s.openDebts.overdueCents)}`}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Faturamento = vendas feitas no período, pagas ou não. Recebido = dinheiro, PIX e cartão
            que de fato entraram (inclui fiado quitado e desconta estornos). O fiado em aberto é a
            diferença entre os dois ao longo do tempo.
          </p>

          <Card>
            <CardHeader>
              <CardTitle>Por dia</CardTitle>
            </CardHeader>
            <CardContent>{daily.data && <DailyChart items={daily.data.items} />}</CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2 [&>*]:min-w-0">
            <Card>
              <CardHeader>
                <CardTitle>Recebimentos por forma de pagamento</CardTitle>
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
                    {s.receipts.byMethod.map((m) => (
                      <tr key={m.method}>
                        <Td>{PAYMENT_METHOD_LABEL[m.method]}</Td>
                        <Td className="text-right tabular-nums">{formatBRL(m.receivedCents)}</Td>
                        <Td className="text-right tabular-nums">{formatBRL(m.refundedCents)}</Td>
                        <Td className="text-right tabular-nums">{formatBRL(m.netCents)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Despesas</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-2 text-2xl font-semibold tabular-nums" data-testid="kpi-expenses">
                  {formatBRL(s.expenses.netCents)}
                </p>
                {s.expenses.byCategory.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Sem despesas no período.</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {s.expenses.byCategory.map((c) => (
                      <li key={c.category} className="flex justify-between py-1.5">
                        <span>{c.category}</span>
                        <span className="tabular-nums">{formatBRL(c.netCents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {s.expenses.reversedCents > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Já descontados {formatBRL(s.expenses.reversedCents)} de despesas estornadas.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Produtos mais vendidos</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <thead>
                    <tr>
                      <Th>Produto</Th>
                      <Th className="text-right">Qtd</Th>
                      <Th className="text-right">Receita</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {top.data?.items.map((p) => (
                      <tr key={p.variantId}>
                        <Td>
                          {p.productName}
                          <span className="block text-xs text-muted-foreground">
                            {[p.sku, p.size, p.color].filter(Boolean).join(' · ')}
                          </span>
                        </Td>
                        <Td className="text-right tabular-nums">{p.quantity}</Td>
                        <Td className="text-right tabular-nums">{formatBRL(p.revenueCents)}</Td>
                      </tr>
                    ))}
                    {top.data?.items.length === 0 && (
                      <tr>
                        <Td colSpan={3} className="py-6 text-center text-muted-foreground">
                          Sem vendas no período.
                        </Td>
                      </tr>
                    )}
                  </tbody>
                </Table>
                <p className="mt-2 text-xs text-muted-foreground">
                  Quantidades já descontam devoluções; vendas canceladas não contam.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Vendedores</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <thead>
                    <tr>
                      <Th>Vendedor</Th>
                      <Th className="text-right">Vendas</Th>
                      <Th className="text-right">Total</Th>
                      <Th className="text-right">Ticket</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {sellers.data?.items.map((x) => (
                      <tr key={x.sellerId}>
                        <Td>{x.sellerName}</Td>
                        <Td className="text-right tabular-nums">{x.salesCount}</Td>
                        <Td className="text-right tabular-nums">{formatBRL(x.salesCents)}</Td>
                        <Td className="text-right tabular-nums">
                          {formatBRL(x.ticketAverageCents)}
                        </Td>
                      </tr>
                    ))}
                    {sellers.data?.items.length === 0 && (
                      <tr>
                        <Td colSpan={4} className="py-6 text-center text-muted-foreground">
                          Sem vendas no período.
                        </Td>
                      </tr>
                    )}
                  </tbody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Resumo de caixa</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Caixas abertos agora</dt>
                    <dd className="tabular-nums">{s.cash.openSessions}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Dinheiro esperado nas gavetas abertas</dt>
                    <dd className="tabular-nums">{formatBRL(s.cash.openExpectedCents)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Caixas fechados no período</dt>
                    <dd className="tabular-nums">{s.cash.closedSessions}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Faltas / sobras</dt>
                    <dd className="tabular-nums">
                      <span className={s.cash.shortageCents > 0 ? 'text-destructive' : ''}>
                        − {formatBRL(s.cash.shortageCents)}
                      </span>
                      {' / '}+ {formatBRL(s.cash.surplusCents)}
                    </dd>
                  </div>
                </dl>
                <Button variant="ghost" size="sm" className="mt-1 -ml-3" asChild>
                  <Link to="/caixa/historico">Ver histórico de caixas</Link>
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Estoque baixo</CardTitle>
              </CardHeader>
              <CardContent>
                <p
                  className={`text-2xl font-semibold tabular-nums ${s.lowStockCount > 0 ? 'text-warning' : ''}`}
                  data-testid="kpi-low-stock"
                >
                  {s.lowStockCount}
                </p>
                <p className="text-sm text-muted-foreground">variante(s) no mínimo ou abaixo.</p>
                <Button variant="ghost" size="sm" className="mt-1 -ml-3" asChild>
                  <Link to="/estoque-baixo">Ver lista</Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Movimentações recentes</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorNotice error={recent.error} />
          <ul className="divide-y text-sm">
            {recent.data?.items.map((m) => (
              <li
                key={`${m.type}-${m.id}`}
                className="flex items-center justify-between gap-3 py-2"
              >
                <div className="min-w-0">
                  <p>
                    {LEDGER_LABEL[m.type]}
                    {m.method &&
                      ` · ${PAYMENT_METHOD_LABEL[m.method as keyof typeof PAYMENT_METHOD_LABEL]}`}
                    {m.saleId && (
                      <>
                        {' · '}
                        <Link
                          className="underline-offset-2 hover:underline"
                          to={`/vendas/${m.saleId}`}
                        >
                          venda #{m.saleNumber}
                        </Link>
                      </>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {formatDateTime(m.at)} · {m.operatorName}
                    {m.description ? ` · ${m.description}` : ''}
                  </p>
                </div>
                <span className="shrink-0 tabular-nums">{formatBRL(m.amountCents)}</span>
              </li>
            ))}
            {recent.data?.items.length === 0 && (
              <li className="py-4 text-muted-foreground">Sem movimentações.</li>
            )}
          </ul>
        </CardContent>
      </Card>
      {s && (
        <p className="mt-2 text-xs text-muted-foreground">
          Período: {formatDateOnly(s.period.from)} a {formatDateOnly(s.period.to)} (fuso da loja).
        </p>
      )}
    </>
  );
}
