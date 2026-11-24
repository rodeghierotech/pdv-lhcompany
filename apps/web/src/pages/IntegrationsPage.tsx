import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ErrorNotice, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/display';
import { Input, Select } from '@/components/ui/form';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';
import { describeApiError } from '@/lib/errors';
import { formatDateTime } from '@/lib/utils';

export interface IntegrationStatus {
  appConfigured: boolean;
  webhookUrl: string | null;
  connection: {
    status: 'ativa' | 'revogada' | 'autorizacao_invalida' | 'desconectada';
    storeId: string;
    scope: string | null;
    connectedAt: string;
    lastEventAt: string | null;
    lastStockConfirmedAt: string | null;
    lastReconcileAt: string | null;
    lastError: string | null;
    restockOnCancel: boolean;
    rateLimitRemaining: number | null;
  } | null;
  counts: {
    linkedVariants: number;
    unlinkedVariants: number;
    outboxPending: number;
    outboxFailed: number;
    eventsPending: number;
    eventsFailed: number;
    openIssues: number;
  };
  oldestPendingStockAt: string | null;
  stockInSync: boolean;
}

interface Issue {
  id: string;
  kind: string;
  title: string;
  details: Record<string, unknown>;
  createdAt: string;
  orderNumber: string | null;
  sku: string | null;
}
interface LinkRow {
  variantId: string;
  sku: string;
  productName: string;
  localStock: number;
  link: { id: string; remoteStockSeen: number | null } | null;
  suggestion: {
    externalVariantId: string;
    name: string;
    sku: string | null;
    stock: number | null;
  } | null;
}
interface OutboxRow {
  id: string;
  status: string;
  delta: number;
  attempts: number;
  lastError: string | null;
  note: string | null;
  createdAt: string;
  sku: string;
}
interface EventRow {
  id: string;
  source: string;
  event: string;
  entityId: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  receivedAt: string;
}
interface OrderRow {
  id: string;
  number: string | null;
  status: string;
  paymentStatus: string;
  paidAt: string | null;
  items: Array<{ sku: string | null; quantity: number; stockStatus: string }>;
}

const CONNECTION_LABEL: Record<string, string> = {
  ativa: 'Conectada',
  revogada: 'Acesso revogado',
  autorizacao_invalida: 'Autorização inválida — reconecte',
  desconectada: 'Desconectada',
};
const KIND_LABEL: Record<string, string> = {
  sem_estoque: 'Pedido pago sem estoque',
  item_nao_mapeado: 'Item sem vínculo',
  estoque_divergente: 'Estoque divergente',
  reembolso_revisar: 'Reembolso a revisar',
  pedido_editado: 'Pedido editado',
  estoque_remoto_insuficiente: 'Estoque remoto insuficiente',
  multiplas_locations: 'Múltiplas locations',
  envio_incerto: 'Envio de estoque incerto',
};
const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  enviado: 'success',
  processado: 'success',
  pendente: 'warning',
  enviando: 'warning',
  processando: 'warning',
  falha: 'destructive',
  conflito: 'destructive',
  ignorado: 'secondary',
  cancelado: 'secondary',
};
const when = (d: string | null) => (d ? formatDateTime(d) : '—');

type Tab = 'resumo' | 'produtos' | 'pendencias' | 'pedidos' | 'estoque' | 'eventos';
const TABS: Array<[Tab, string]> = [
  ['resumo', 'Resumo'],
  ['produtos', 'Produtos'],
  ['pendencias', 'Pendências'],
  ['pedidos', 'Pedidos online'],
  ['estoque', 'Fila de estoque'],
  ['eventos', 'Eventos'],
];

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['integration'] });
}

function Summary({ status }: { status: IntegrationStatus }) {
  const { can } = useAuth();
  const invalidate = useInvalidate();
  const c = status.connection;
  const fail = (e: unknown) => toast.error(describeApiError(e));
  const install = useMutation({
    mutationFn: () =>
      api<{ url: string }>('/integrations/nuvemshop/install-url', { method: 'POST' }),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: fail,
  });
  const syncNow = useMutation({
    mutationFn: () => api('/integrations/nuvemshop/sync-now', { method: 'POST' }),
    onSuccess: () => {
      toast.success('Ciclo executado');
      invalidate();
    },
    onError: fail,
  });
  const register = useMutation({
    mutationFn: () =>
      api<{ created: string[] }>('/integrations/nuvemshop/webhooks/register', { method: 'POST' }),
    onSuccess: (r) => {
      toast.success(`${r.created.length} webhook(s) registrado(s) na loja`);
      invalidate();
    },
    onError: fail,
  });
  const disconnect = useMutation({
    mutationFn: () => api('/integrations/nuvemshop/disconnect', { method: 'POST' }),
    onSuccess: invalidate,
    onError: fail,
  });
  const restock = useMutation({
    mutationFn: (v: boolean) =>
      api('/integrations/nuvemshop/settings', { method: 'PATCH', body: { restockOnCancel: v } }),
    onSuccess: invalidate,
    onError: fail,
  });
  const n = status.counts;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Conexão</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!status.appConfigured && (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-3" role="alert">
              Aplicativo Nuvemshop não configurado no servidor (NUVEMSHOP_APP_ID /
              NUVEMSHOP_CLIENT_SECRET). Nenhuma comunicação com a loja é feita sem essas
              credenciais.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={c?.status === 'ativa' ? 'success' : c ? 'destructive' : 'secondary'}
              data-testid="connection-status"
            >
              {c ? CONNECTION_LABEL[c.status] : 'Não conectada'}
            </Badge>
            {c && <span className="text-muted-foreground">Loja {c.storeId}</span>}
          </div>
          {c?.lastError && <p className="text-xs text-destructive">Último erro: {c.lastError}</p>}
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Último evento recebido</dt>
              <dd>{when(c?.lastEventAt ?? null)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Último estoque confirmado pela loja</dt>
              <dd>{when(c?.lastStockConfirmedAt ?? null)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Última reconciliação</dt>
              <dd>{when(c?.lastReconcileAt ?? null)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Limite de requisições restante</dt>
              <dd>{c?.rateLimitRemaining ?? '—'}</dd>
            </div>
          </dl>
          <div
            className={`rounded-md border p-3 ${status.stockInSync ? 'border-success/40' : 'border-warning/40'}`}
            data-testid="stock-sync-state"
          >
            {status.stockInSync
              ? 'Estoque confirmado pela Nuvemshop: nenhuma atualização pendente.'
              : `Estoque NÃO confirmado: ${n.outboxPending} pendente(s), ${n.outboxFailed} em falha/conflito${status.oldestPendingStockAt ? ` — mais antigo em ${when(status.oldestPendingStockAt)}` : ''}.`}
          </div>
          {can('integration:manage') && (
            <div className="flex flex-wrap gap-2">
              {status.appConfigured && (
                <Button
                  size="sm"
                  variant={c?.status === 'ativa' ? 'outline' : 'default'}
                  disabled={install.isPending}
                  onClick={() => install.mutate()}
                >
                  {c?.status === 'ativa' ? 'Reautorizar' : 'Conectar à Nuvemshop'}
                </Button>
              )}
              {c?.status === 'ativa' && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={syncNow.isPending}
                  onClick={() => syncNow.mutate()}
                >
                  <RefreshCw className={syncNow.isPending ? 'animate-spin' : ''} /> Sincronizar e
                  reconciliar agora
                </Button>
              )}
            </div>
          )}
          {can('integration:admin') && c?.status === 'ativa' && (
            <div className="space-y-2 border-t pt-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={c.restockOnCancel}
                  onChange={(e) => restock.mutate(e.target.checked)}
                />
                Repor estoque ao cancelar pedido online já baixado
              </label>
              <p className="text-xs text-muted-foreground">
                Registrar webhooks altera a loja (cria assinaturas apontando para{' '}
                {status.webhookUrl ?? 'PUBLIC_API_URL não configurada'}).
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!status.webhookUrl || register.isPending}
                  onClick={() =>
                    window.confirm('Registrar webhooks na loja Nuvemshop?') && register.mutate()
                  }
                >
                  Registrar webhooks
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() =>
                    window.confirm('Desconectar e apagar a credencial?') && disconnect.mutate()
                  }
                >
                  Desconectar
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="grid gap-3 pt-6 text-sm sm:grid-cols-3 lg:grid-cols-6">
          {[
            ['Variantes vinculadas', n.linkedVariants],
            ['Sem vínculo', n.unlinkedVariants],
            ['Pendências abertas', n.openIssues],
            ['Estoque a enviar', n.outboxPending],
            ['Envios com falha', n.outboxFailed],
            ['Eventos com falha', n.eventsFailed],
          ].map(([label, v]) => (
            <div key={label as string}>
              <p className="text-muted-foreground">{label}</p>
              <p className="text-lg font-semibold">{v}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Products() {
  const { can } = useAuth();
  const invalidate = useInvalidate();
  const [filter, setFilter] = useState<'todos' | 'vinculados' | 'nao_vinculados'>('nao_vinculados');
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: ['integration', 'links', filter, q],
    queryFn: () =>
      api<{ items: LinkRow[] }>('/integrations/nuvemshop/links', {
        query: { filter, q: q || undefined },
      }),
  });
  const importCat = useMutation({
    mutationFn: () =>
      api<{ variants: number }>('/integrations/nuvemshop/catalog/import', { method: 'POST' }),
    onSuccess: (r) => {
      toast.success(`${r.variants} variante(s) lidas da loja (somente leitura)`);
      invalidate();
    },
    onError: (e) => toast.error(describeApiError(e)),
  });
  const link = useMutation({
    mutationFn: (v: { variantId: string; externalVariantId: string }) =>
      api('/integrations/nuvemshop/links', { method: 'POST', body: v }),
    onSuccess: () => {
      toast.success('Vínculo criado (o estoque não foi alterado)');
      invalidate();
    },
    onError: (e) => toast.error(describeApiError(e)),
  });
  const unlink = useMutation({
    mutationFn: (id: string) => api(`/integrations/nuvemshop/links/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: (e) => toast.error(describeApiError(e)),
  });
  const manage = can('integration:manage');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Vínculo de produtos</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Select
            aria-label="Filtro"
            className="w-44"
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
          >
            <option value="nao_vinculados">Sem vínculo</option>
            <option value="vinculados">Vinculados</option>
            <option value="todos">Todos</option>
          </Select>
          <Input
            aria-label="Buscar"
            placeholder="SKU ou nome"
            className="max-w-xs"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {manage && (
            <Button
              variant="outline"
              disabled={importCat.isPending}
              onClick={() => importCat.mutate()}
            >
              Importar catálogo da loja
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          O vínculo usa os IDs da Nuvemshop; o SKU apenas sugere. Fonte da verdade: estoque = PDV;
          catálogo e preço = PDV (não são enviados).
        </p>
        {list.error && <ErrorNotice error={list.error} />}
        <ul className="divide-y">
          {list.data?.items.map((r) => (
            <li
              key={r.variantId}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <div>
                <p className="font-medium">
                  {r.productName} <span className="text-muted-foreground">· {r.sku}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  PDV: {r.localStock}
                  {r.link
                    ? ` · Loja (última leitura): ${r.link.remoteStockSeen ?? 'ilimitado'}`
                    : ''}
                  {!r.link && r.suggestion
                    ? ` · Sugestão por SKU: ${r.suggestion.name} (estoque ${r.suggestion.stock ?? 'ilimitado'})`
                    : ''}
                </p>
              </div>
              {manage && r.link && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    window.confirm('Desvincular esta variante?') && unlink.mutate(r.link!.id)
                  }
                >
                  Desvincular
                </Button>
              )}
              {manage && !r.link && r.suggestion && (
                <Button
                  size="sm"
                  disabled={link.isPending}
                  onClick={() =>
                    link.mutate({
                      variantId: r.variantId,
                      externalVariantId: r.suggestion!.externalVariantId,
                    })
                  }
                >
                  Vincular
                </Button>
              )}
            </li>
          ))}
          {list.data?.items.length === 0 && (
            <li className="py-6 text-center text-sm text-muted-foreground">Nada para mostrar.</li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}

function IssueItem({ issue }: { issue: Issue }) {
  const { can } = useAuth();
  const invalidate = useInvalidate();
  const [note, setNote] = useState('');
  const resolve = useMutation({
    mutationFn: (action: string) =>
      api(`/integrations/issues/${issue.id}/resolve`, {
        method: 'POST',
        body: { action, note: note || undefined },
      }),
    onSuccess: () => {
      toast.success('Pendência resolvida');
      invalidate();
    },
    onError: (e) => toast.error(describeApiError(e)),
  });
  const manage = can('integration:manage');
  return (
    <li className="space-y-2 py-3" data-testid="integration-issue">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="warning">{KIND_LABEL[issue.kind] ?? issue.kind}</Badge>
        <span className="text-sm">{issue.title}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {formatDateTime(issue.createdAt)}
        {issue.sku ? ` · ${issue.sku}` : ''}
      </p>
      {manage && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Observação"
            placeholder="Observação"
            className="max-w-xs"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {(issue.kind === 'estoque_divergente' || issue.kind === 'envio_incerto') && (
            <>
              <Button
                size="sm"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate('aceitar_remoto')}
              >
                Aceitar estoque da loja
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={resolve.isPending}
                onClick={() =>
                  window.confirm('Sobrescrever o estoque da loja com o do PDV?') &&
                  resolve.mutate('enviar_local')
                }
              >
                Enviar estoque do PDV
              </Button>
            </>
          )}
          {(issue.kind === 'sem_estoque' || issue.kind === 'item_nao_mapeado') && (
            <Button
              size="sm"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate('baixar_agora')}
            >
              Baixar estoque agora
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate('ignorar')}
          >
            Marcar como tratada
          </Button>
        </div>
      )}
    </li>
  );
}

function Issues() {
  const q = useQuery({
    queryKey: ['integration', 'issues'],
    queryFn: () => api<{ items: Issue[] }>('/integrations/issues'),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pendências e conflitos</CardTitle>
      </CardHeader>
      <CardContent>
        {q.error && <ErrorNotice error={q.error} />}
        <ul className="divide-y">
          {q.data?.items.map((i) => (
            <IssueItem key={i.id} issue={i} />
          ))}
        </ul>
        {q.data?.items.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nenhuma pendência aberta.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Orders() {
  const q = useQuery({
    queryKey: ['integration', 'orders'],
    queryFn: () => api<{ items: OrderRow[] }>('/integrations/orders'),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pedidos online</CardTitle>
      </CardHeader>
      <CardContent>
        {q.error && <ErrorNotice error={q.error} />}
        <ul className="divide-y text-sm">
          {q.data?.items.map((o) => (
            <li key={o.id} className="py-2">
              <p className="font-medium">
                #{o.number ?? o.id} <Badge variant="secondary">{o.status}</Badge>{' '}
                <Badge variant={o.paymentStatus === 'paid' ? 'success' : 'warning'}>
                  {o.paymentStatus}
                </Badge>
              </p>
              <p className="text-xs text-muted-foreground">
                {o.items
                  .map((i) => `${i.quantity}× ${i.sku ?? 'item'} (${i.stockStatus})`)
                  .join(' · ')}
              </p>
            </li>
          ))}
        </ul>
        {q.data?.items.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">Nenhum pedido recebido.</p>
        )}
      </CardContent>
    </Card>
  );
}

function Outbox() {
  const { can } = useAuth();
  const invalidate = useInvalidate();
  const q = useQuery({
    queryKey: ['integration', 'outbox'],
    queryFn: () => api<{ items: OutboxRow[] }>('/integrations/outbox'),
  });
  const retry = useMutation({
    mutationFn: (id: string) => api(`/integrations/outbox/${id}/retry`, { method: 'POST' }),
    onSuccess: invalidate,
    onError: (e) => toast.error(describeApiError(e)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Fila de atualização de estoque</CardTitle>
      </CardHeader>
      <CardContent>
        {q.error && <ErrorNotice error={q.error} />}
        <ul className="divide-y text-sm">
          {q.data?.items.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <p>
                  {o.sku} · {o.delta > 0 ? '+' : ''}
                  {o.delta}{' '}
                  <Badge variant={STATUS_VARIANT[o.status] ?? 'secondary'}>
                    {o.status === 'enviado' ? 'confirmado pela loja' : o.status}
                  </Badge>
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(o.createdAt)} · tentativas: {o.attempts}
                  {o.note ? ` · ${o.note}` : ''}
                  {o.lastError ? ` · ${o.lastError}` : ''}
                </p>
              </div>
              {can('integration:manage') && ['falha', 'conflito'].includes(o.status) && (
                <Button size="sm" variant="outline" onClick={() => retry.mutate(o.id)}>
                  Reprocessar
                </Button>
              )}
            </li>
          ))}
        </ul>
        {q.data?.items.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">Fila vazia.</p>
        )}
      </CardContent>
    </Card>
  );
}

function Events() {
  const { can } = useAuth();
  const invalidate = useInvalidate();
  const q = useQuery({
    queryKey: ['integration', 'events'],
    queryFn: () => api<{ items: EventRow[] }>('/integrations/events'),
  });
  const retry = useMutation({
    mutationFn: (id: string) => api(`/integrations/events/${id}/retry`, { method: 'POST' }),
    onSuccess: invalidate,
    onError: (e) => toast.error(describeApiError(e)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Eventos recebidos</CardTitle>
      </CardHeader>
      <CardContent>
        {q.error && <ErrorNotice error={q.error} />}
        <ul className="divide-y text-sm">
          {q.data?.items.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <p>
                  {e.event} {e.entityId ? `#${e.entityId}` : ''}{' '}
                  <Badge variant={STATUS_VARIANT[e.status] ?? 'secondary'}>{e.status}</Badge>{' '}
                  <span className="text-xs text-muted-foreground">({e.source})</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(e.receivedAt)} · tentativas: {e.attempts}
                  {e.lastError ? ` · ${e.lastError}` : ''}
                </p>
              </div>
              {can('integration:manage') && ['falha', 'ignorado'].includes(e.status) && (
                <Button size="sm" variant="outline" onClick={() => retry.mutate(e.id)}>
                  Reprocessar
                </Button>
              )}
            </li>
          ))}
        </ul>
        {q.data?.items.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">Nenhum evento.</p>
        )}
      </CardContent>
    </Card>
  );
}

export function IntegrationsPage() {
  const [tab, setTab] = useState<Tab>('resumo');
  const status = useQuery({
    queryKey: ['integration', 'status'],
    queryFn: () => api<IntegrationStatus>('/integrations/nuvemshop/status'),
    refetchInterval: 15_000,
  });
  return (
    <div className="space-y-4">
      <PageHeader title="Integração Nuvemshop" />
      {status.error && <ErrorNotice error={status.error} />}
      <div role="tablist" aria-label="Seções" className="flex flex-wrap gap-1">
        {TABS.map(([id, label]) => (
          <Button
            key={id}
            role="tab"
            aria-selected={tab === id}
            size="sm"
            variant={tab === id ? 'default' : 'outline'}
            onClick={() => setTab(id)}
          >
            {label}
            {id === 'pendencias' && status.data && status.data.counts.openIssues > 0
              ? ` (${status.data.counts.openIssues})`
              : ''}
          </Button>
        ))}
      </div>
      {tab === 'resumo' && status.data && <Summary status={status.data} />}
      {tab === 'produtos' && <Products />}
      {tab === 'pendencias' && <Issues />}
      {tab === 'pedidos' && <Orders />}
      {tab === 'estoque' && <Outbox />}
      {tab === 'eventos' && <Events />}
    </div>
  );
}
