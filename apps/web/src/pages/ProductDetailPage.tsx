import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, PackagePlus, Pencil, Plus, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { formatBRL } from '@pdv/shared';
import type { ProductDTO, VariantDTO } from '@pdv/shared';
import { ErrorNotice, PageHeader, StockBadge } from '@/components/shared';
import { StockAdjustDialog, StockEntryDialog, StockHistoryDialog } from '@/components/StockDialogs';
import { AddVariantDialog, EditVariantDialog } from '@/components/VariantDialogs';
import { Button } from '@/components/ui/button';
import { Badge, Card, Table, Td, Th } from '@/components/ui/display';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';

type DialogState =
  { kind: 'entry' | 'adjust' | 'history' | 'edit'; variant: VariantDTO } | { kind: 'add' } | null;

export function ProductDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<DialogState>(null);
  const close = (open: boolean) => !open && setDialog(null);

  const query = useQuery({
    queryKey: ['product', id],
    queryFn: () => api<{ product: ProductDTO }>(`/products/${id}`),
  });

  const toggleActive = useMutation({
    mutationFn: (active: boolean) => api(`/products/${id}`, { method: 'PATCH', body: { active } }),
    onSuccess: () => {
      toast.success('Produto atualizado');
      void queryClient.invalidateQueries({ queryKey: ['product', id] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });

  const product = query.data?.product;
  if (query.isLoading) return <p className="text-muted-foreground">Carregando…</p>;
  if (!product) return <ErrorNotice error={query.error ?? new Error('Produto não encontrado')} />;

  const canWrite = can('product:write');
  const canEntry = can('stock:entry');
  const canAdjust = can('stock:adjust');

  return (
    <>
      <PageHeader
        title={product.name}
        actions={
          <>
            <Button variant="ghost" asChild>
              <Link to="/produtos">Voltar</Link>
            </Button>
            {canWrite && (
              <>
                <Button
                  variant="outline"
                  disabled={toggleActive.isPending}
                  onClick={() => toggleActive.mutate(!product.active)}
                >
                  {product.active ? 'Desativar' : 'Reativar'}
                </Button>
                <Button onClick={() => setDialog({ kind: 'add' })}>
                  <Plus /> Variante
                </Button>
              </>
            )}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {product.active ? (
          <Badge variant="success">Ativo</Badge>
        ) : (
          <Badge variant="secondary">Inativo</Badge>
        )}
        <span>{product.categoryName ?? 'Sem categoria'}</span>
        {product.description && <span>· {product.description}</span>}
      </div>
      <ErrorNotice error={toggleActive.error} />

      <Card>
        <Table>
          <thead>
            <tr>
              <Th>SKU</Th>
              <Th>Tam. / Cor</Th>
              <Th className="text-right">Preço</Th>
              <Th className="text-right">Custo</Th>
              <Th className="text-right">Estoque</Th>
              <Th>Situação</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {product.variants.map((v) => (
              <tr key={v.id} className={v.active ? undefined : 'opacity-60'}>
                <Td>
                  <div className="font-medium">{v.sku}</div>
                  {v.barcode && <div className="text-xs text-muted-foreground">{v.barcode}</div>}
                </Td>
                <Td>{[v.size, v.color].filter(Boolean).join(' / ') || '—'}</Td>
                <Td className="text-right tabular-nums">{formatBRL(v.priceCents)}</Td>
                <Td className="text-right tabular-nums text-muted-foreground">
                  {formatBRL(v.costCents)}
                </Td>
                <Td className="text-right text-base font-semibold tabular-nums">{v.stock}</Td>
                <Td>
                  <StockBadge stock={v.stock} min={v.minStock} />
                </Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    {canEntry && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Entrada de estoque ${v.sku}`}
                        onClick={() => setDialog({ kind: 'entry', variant: v })}
                      >
                        <PackagePlus />
                      </Button>
                    )}
                    {canAdjust && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Ajustar estoque ${v.sku}`}
                        onClick={() => setDialog({ kind: 'adjust', variant: v })}
                      >
                        <SlidersHorizontal />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Histórico ${v.sku}`}
                      onClick={() => setDialog({ kind: 'history', variant: v })}
                    >
                      <History />
                    </Button>
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Editar ${v.sku}`}
                        onClick={() => setDialog({ kind: 'edit', variant: v })}
                      >
                        <Pencil />
                      </Button>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {dialog?.kind === 'add' && <AddVariantDialog product={product} open onOpenChange={close} />}
      {dialog?.kind === 'entry' && (
        <StockEntryDialog
          key={dialog.variant.id}
          variant={dialog.variant}
          open
          onOpenChange={close}
        />
      )}
      {dialog?.kind === 'adjust' && (
        <StockAdjustDialog
          key={dialog.variant.id}
          variant={dialog.variant}
          open
          onOpenChange={close}
        />
      )}
      {dialog?.kind === 'history' && (
        <StockHistoryDialog
          key={dialog.variant.id}
          variant={dialog.variant}
          open
          onOpenChange={close}
        />
      )}
      {dialog?.kind === 'edit' && (
        <EditVariantDialog
          key={dialog.variant.id}
          variant={dialog.variant}
          productId={product.id}
          open
          onOpenChange={close}
        />
      )}
    </>
  );
}
