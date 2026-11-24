import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { formatBRL } from '@pdv/shared';
import type { SyncConflictDTO, SyncResultDTO } from '@pdv/shared';
import { ErrorNotice } from '@/components/shared';
import { SyncBadge } from '@/components/SyncBadge';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/display';
import { Input } from '@/components/ui/form';
import { useAuth } from '@/hooks/useAuth';
import { subscribeQueue, useOffline } from '@/hooks/useOffline';
import { api } from '@/lib/api';
import { describeApiError } from '@/lib/errors';
import type { LocalOperation } from '@/lib/offline/db';
import { listOperations } from '@/lib/offline/store';
import { formatDateTime } from '@/lib/utils';

interface SyncIssue {
  operationId: string;
  status: SyncResultDTO['status'];
  sellerName: string;
  clientCreatedAt: string;
  totalCents: number;
  errorCode: string | null;
  errorMessage: string | null;
  approvable: boolean;
  saleId: string | null;
  conflicts: SyncConflictDTO[];
}

function Conflicts({ items }: { items?: SyncConflictDTO[] }) {
  if (!items?.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      {items.map((c, i) => (
        <li key={i}>
          <Badge variant={c.blocking ? 'destructive' : 'warning'} className="mr-1">
            {c.code}
          </Badge>
          {c.message}
        </li>
      ))}
    </ul>
  );
}

function IssueRow({ issue }: { issue: SyncIssue }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const resolve = useMutation({
    mutationFn: (action: 'aprovar' | 'descartar') =>
      api(`/sync/operations/${issue.operationId}/resolve`, {
        method: 'POST',
        body: { action, note },
      }),
    onSuccess: () => {
      toast.success('Decisão registrada');
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['sync-issues'] });
    },
    onError: (e) => toast.error(describeApiError(e)),
  });
  const ack = useMutation({
    mutationFn: () => api(`/sync/operations/${issue.operationId}/acknowledge`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['sync-issues'] }),
  });
  const blocked = issue.status === 'conflito';
  return (
    <li className="space-y-2 py-3" data-testid="sync-issue">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">
            {formatBRL(issue.totalCents)} · {issue.sellerName} ·{' '}
            {formatDateTime(issue.clientCreatedAt)}
          </p>
          {issue.errorMessage && (
            <p className="text-xs text-destructive">
              {issue.errorCode}: {issue.errorMessage}
            </p>
          )}
          <Conflicts items={issue.conflicts} />
        </div>
        <SyncBadge state={issue.status === 'confirmada' ? 'confirmada' : issue.status} />
      </div>
      {blocked ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Justificativa"
            placeholder="Justificativa (obrigatória)"
            className="max-w-xs"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {issue.approvable && (
            <Button
              size="sm"
              disabled={note.trim().length < 3 || resolve.isPending}
              onClick={() => resolve.mutate('aprovar')}
            >
              {issue.errorCode === 'CASH_SESSION_CLOSED'
                ? 'Regularizar no caixa aberto do vendedor'
                : 'Aprovar e registrar venda'}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={note.trim().length < 3 || resolve.isPending}
            onClick={() => resolve.mutate('descartar')}
          >
            Descartar
          </Button>
        </div>
      ) : issue.status === 'confirmada' ? (
        <Button variant="outline" size="sm" onClick={() => ack.mutate()}>
          Ciente
        </Button>
      ) : null}
    </li>
  );
}

export function SyncPage() {
  const { can } = useAuth();
  const { online, pending, syncing, syncNow, grantExpiresAt, grantValid, catalogAt, lastSyncAt } =
    useOffline();
  const [ops, setOps] = useState<LocalOperation[]>([]);
  useEffect(() => {
    const load = () => void listOperations().then(setOps);
    load();
    return subscribeQueue(load);
  }, []);

  const issues = useQuery({
    queryKey: ['sync-issues'],
    queryFn: () => api<{ items: SyncIssue[] }>('/sync/issues'),
    enabled: can('sync:resolve') && online,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Sincronização</h1>
        <Button
          disabled={!online || syncing}
          onClick={() => void syncNow().then(() => toast.success('Sincronização executada'))}
        >
          <RefreshCw className={syncing ? 'animate-spin' : ''} /> Sincronizar agora
        </Button>
      </div>

      <Card>
        <CardContent className="grid gap-3 pt-6 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-muted-foreground">Conexão</p>
            <p className="font-medium">{online ? 'Servidor acessível' : 'Sem conexão'}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Vendas aguardando o servidor</p>
            <p className="font-medium" data-testid="pending-count">
              {pending}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Autorização offline</p>
            <p className="font-medium">
              {grantExpiresAt
                ? `${grantValid ? 'válida até' : 'expirada em'} ${formatDateTime(new Date(grantExpiresAt).toISOString())}`
                : 'não emitida'}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Catálogo local</p>
            <p className="font-medium">{catalogAt ? formatDateTime(catalogAt) : 'não baixado'}</p>
            {lastSyncAt && (
              <p className="text-xs text-muted-foreground">
                Último envio {new Date(lastSyncAt).toLocaleTimeString('pt-BR')}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Vendas deste aparelho</CardTitle>
        </CardHeader>
        <CardContent>
          {ops.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nenhuma venda offline registrada neste aparelho.
            </p>
          ) : (
            <ul className="divide-y">
              {ops.map((o) => (
                <li
                  key={o.operationId}
                  className="flex flex-wrap items-start justify-between gap-2 py-3"
                  data-testid="local-op"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {formatBRL(o.summary.totalCents)} · {o.summary.itemCount} peça(s) ·{' '}
                      {formatDateTime(o.createdAt)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Seq. {o.sequence}
                      {o.saleNumber ? ` · venda #${o.saleNumber}` : ''}
                      {o.attempts > 0 ? ` · ${o.attempts} tentativa(s)` : ''}
                      {o.resolution ? ` · ${o.resolution}` : ''}
                    </p>
                    {o.error && <p className="text-xs text-destructive">{o.error.message}</p>}
                    <Conflicts items={o.conflicts} />
                  </div>
                  <SyncBadge state={o.state} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {can('sync:resolve') && (
        <Card>
          <CardHeader>
            <CardTitle>Conflitos e divergências no servidor</CardTitle>
          </CardHeader>
          <CardContent>
            {issues.error && <ErrorNotice error={issues.error} />}
            {issues.data?.items.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">Nada pendente.</p>
            )}
            <ul className="divide-y">
              {issues.data?.items.map((i) => (
                <IssueRow key={i.operationId} issue={i} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
