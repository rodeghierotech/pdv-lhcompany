import { useMutation, useQueryClient } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { parseBRLToCents } from '@pdv/shared';
import { invalidateCash, SessionPanel } from '@/components/CashSessionView';
import { ErrorNotice, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/display';
import { Field, Input } from '@/components/ui/form';
import { useAuth } from '@/hooks/useAuth';
import { useCashSession } from '@/hooks/useCashSession';
import { api } from '@/lib/api';
import { newIdempotencyKey } from '@/lib/utils';

function OpenCashForm() {
  const queryClient = useQueryClient();
  const [opening, setOpening] = useState('');
  const key = useRef(newIdempotencyKey());
  const cents = opening.trim() === '' ? null : parseBRLToCents(opening);
  const open = useMutation({
    mutationFn: () =>
      api('/cash/open', {
        method: 'POST',
        body: { idempotencyKey: key.current, openingCents: cents },
      }),
    onSuccess: () => {
      toast.success('Caixa aberto');
      invalidateCash(queryClient);
    },
  });
  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Abrir caixa</CardTitle>
        <p className="text-sm text-muted-foreground">
          Informe o dinheiro que está na gaveta agora. Sem caixa aberto não é possível vender nem
          receber.
        </p>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (cents !== null) open.mutate();
          }}
        >
          <Field label="Valor inicial (R$) *" htmlFor="opening">
            <Input
              id="opening"
              inputMode="decimal"
              placeholder="0,00"
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
              autoFocus
            />
          </Field>
          <ErrorNotice error={open.error} />
          <Button type="submit" disabled={cents === null || open.isPending}>
            Abrir caixa
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function CashPage() {
  const { can } = useAuth();
  const { data, error, isLoading } = useCashSession();
  return (
    <>
      <PageHeader
        title="Caixa"
        actions={
          can('cash:read') && (
            <Button variant="outline" asChild>
              <Link to="/caixa/historico">
                <History /> Histórico
              </Link>
            </Button>
          )
        }
      />
      <ErrorNotice error={error} />
      {isLoading ? (
        <p className="text-muted-foreground">Carregando…</p>
      ) : data?.session ? (
        <SessionPanel sessionId={data.session.id} live />
      ) : can('cash:open') ? (
        <OpenCashForm />
      ) : (
        <p className="text-muted-foreground">Sem permissão para abrir caixa.</p>
      )}
    </>
  );
}
