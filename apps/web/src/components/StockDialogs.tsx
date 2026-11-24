import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { toast } from 'sonner';
import { parseBRLToCents } from '@pdv/shared';
import type { Paginated, StockMovementDTO, VariantDTO } from '@pdv/shared';
import { ErrorNotice, MoneyInput } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Badge, Table, Td, Th } from '@/components/ui/display';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';
import { formatDateTime, newIdempotencyKey } from '@/lib/utils';

interface BaseProps {
  variant: VariantDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function useRefreshStock() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['product'] });
    void queryClient.invalidateQueries({ queryKey: ['products'] });
    void queryClient.invalidateQueries({ queryKey: ['movements'] });
    void queryClient.invalidateQueries({ queryKey: ['low-stock'] });
  };
}

const variantLabel = (v: VariantDTO) =>
  [v.sku, v.size, v.color].filter(Boolean).join(' · ') + ` — estoque atual: ${v.stock}`;

/**
 * A chave de idempotência vive enquanto a ação não for concluída: um reenvio (ex.: resposta perdida
 * por queda de rede) reaproveita a chave e o servidor não duplica a operação.
 */
export function StockEntryDialog({ variant, open, onOpenChange }: BaseProps) {
  const refresh = useRefreshStock();
  const key = useRef(newIdempotencyKey());
  const [quantity, setQuantity] = useState('');
  const [cost, setCost] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (body: unknown) => api('/stock/entries', { method: 'POST', body }),
    onSuccess: () => {
      toast.success('Entrada registrada');
      key.current = newIdempotencyKey();
      setQuantity('');
      setCost('');
      setNote('');
      refresh();
      onOpenChange(false);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1)
      return setFormError('Quantidade: informe um inteiro maior que zero');
    const unitCostCents = cost.trim() ? parseBRLToCents(cost) : undefined;
    if (unitCostCents === null) return setFormError('Custo: valor inválido');
    setFormError(null);
    mutation.mutate({
      variantId: variant.id,
      quantity: qty,
      ...(unitCostCents !== undefined ? { unitCostCents } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      idempotencyKey: key.current,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Entrada de estoque" description={variantLabel(variant)}>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Quantidade *" htmlFor="entry-qty">
            <Input
              id="entry-qty"
              inputMode="numeric"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              autoFocus
            />
          </Field>
          <Field
            label="Custo unitário (R$)"
            htmlFor="entry-cost"
            hint="Se vazio, usa o custo cadastrado na variante."
          >
            <MoneyInput id="entry-cost" value={cost} onChange={(e) => setCost(e.target.value)} />
          </Field>
          <Field label="Observação" htmlFor="entry-note">
            <Input
              id="entry-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
            />
          </Field>
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
          <ErrorNotice error={mutation.error} />
          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending ? 'Registrando…' : 'Registrar entrada'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function StockAdjustDialog({ variant, open, onOpenChange }: BaseProps) {
  const refresh = useRefreshStock();
  const key = useRef(newIdempotencyKey());
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (body: unknown) => api('/stock/adjustments', { method: 'POST', body }),
    onSuccess: () => {
      toast.success('Ajuste registrado');
      key.current = newIdempotencyKey();
      setDelta('');
      setReason('');
      refresh();
      onOpenChange(false);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const d = Number(delta);
    if (!Number.isInteger(d) || d === 0)
      return setFormError('Variação: informe um inteiro diferente de zero (ex.: -2 ou 3)');
    if (reason.trim().length < 3) return setFormError('Motivo: descreva o motivo do ajuste');
    if (variant.stock + d < 0)
      return setFormError(`O ajuste deixaria o estoque negativo (atual: ${variant.stock})`);
    setFormError(null);
    mutation.mutate({
      variantId: variant.id,
      delta: d,
      reason: reason.trim(),
      idempotencyKey: key.current,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Ajuste de estoque"
        description={`${variantLabel(variant)}. Ajustes ficam registrados e só podem ser corrigidos por estorno.`}
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Variação *" htmlFor="adj-delta" hint="Negativo remove, positivo adiciona.">
            <Input
              id="adj-delta"
              inputMode="numeric"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Motivo *" htmlFor="adj-reason">
            <Input
              id="adj-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
            />
          </Field>
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
          <ErrorNotice error={mutation.error} />
          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending ? 'Registrando…' : 'Registrar ajuste'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const TYPE_LABEL: Record<StockMovementDTO['type'], string> = {
  entrada: 'Entrada',
  ajuste: 'Ajuste',
  venda: 'Venda',
  devolucao: 'Devolução',
  estorno: 'Estorno',
  pedido_online: 'Pedido online',
  estorno_pedido_online: 'Cancelamento online',
};

export function StockHistoryDialog({ variant, open, onOpenChange }: BaseProps) {
  const { can } = useAuth();
  const refresh = useRefreshStock();
  const reverseKeys = useRef(new Map<string, string>());
  const movements = useQuery({
    queryKey: ['movements', variant.id],
    queryFn: () =>
      api<Paginated<StockMovementDTO>>('/stock/movements', {
        query: { variantId: variant.id, pageSize: 50 },
      }),
    enabled: open,
  });

  const reverse = useMutation({
    mutationFn: (m: StockMovementDTO) => {
      // Mesma chave para a mesma movimentação: clique duplo ou retentativa não estorna duas vezes.
      let key = reverseKeys.current.get(m.id);
      if (!key) {
        key = newIdempotencyKey();
        reverseKeys.current.set(m.id, key);
      }
      return api(`/stock/movements/${m.id}/reverse`, {
        method: 'POST',
        body: { reason: `Estorno de ${TYPE_LABEL[m.type].toLowerCase()}`, idempotencyKey: key },
      });
    },
    onSuccess: () => {
      toast.success('Movimentação estornada');
      refresh();
    },
  });

  const reversed = new Set(
    movements.data?.items.flatMap((m) => (m.reversesMovementId ? [m.reversesMovementId] : [])),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Histórico de movimentações"
        description={variantLabel(variant)}
        className="max-w-2xl"
      >
        <ErrorNotice error={movements.error ?? reverse.error} />
        <Table>
          <thead>
            <tr>
              <Th>Data</Th>
              <Th>Tipo</Th>
              <Th className="text-right">Qtd.</Th>
              <Th>Motivo</Th>
              <Th>Por</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {movements.data?.items.map((m) => (
              <tr key={m.id}>
                <Td className="whitespace-nowrap">{formatDateTime(m.createdAt)}</Td>
                <Td>
                  <Badge variant={m.type === 'estorno' ? 'warning' : 'secondary'}>
                    {TYPE_LABEL[m.type]}
                  </Badge>
                </Td>
                <Td className="text-right tabular-nums">
                  {m.quantityDelta > 0 ? `+${m.quantityDelta}` : m.quantityDelta}
                </Td>
                <Td className="text-muted-foreground">{m.reason ?? '—'}</Td>
                <Td className="text-muted-foreground">{m.actorName ?? '—'}</Td>
                <Td>
                  {can('stock:adjust') &&
                    (m.type === 'entrada' || m.type === 'ajuste') &&
                    (reversed.has(m.id) ? (
                      <span className="text-xs text-muted-foreground">Estornada</span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={reverse.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              'Estornar esta movimentação? Será criada uma movimentação compensatória.',
                            )
                          ) {
                            reverse.mutate(m);
                          }
                        }}
                      >
                        Estornar
                      </Button>
                    ))}
                </Td>
              </tr>
            ))}
            {movements.data?.items.length === 0 && (
              <tr>
                <Td colSpan={6} className="py-6 text-center text-muted-foreground">
                  Sem movimentações.
                </Td>
              </tr>
            )}
          </tbody>
        </Table>
      </DialogContent>
    </Dialog>
  );
}
