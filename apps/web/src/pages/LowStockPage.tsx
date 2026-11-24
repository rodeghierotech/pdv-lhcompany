import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { VariantDTO } from '@pdv/shared';
import { ErrorNotice, PageHeader, StockBadge } from '@/components/shared';
import { Card, Table, Td, Th } from '@/components/ui/display';
import { api } from '@/lib/api';

export function LowStockPage() {
  const query = useQuery({
    queryKey: ['low-stock'],
    queryFn: () => api<{ items: VariantDTO[] }>('/stock/low'),
  });

  return (
    <>
      <PageHeader title="Estoque baixo" />
      <ErrorNotice error={query.error} />
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>SKU</Th>
              <Th>Tam. / Cor</Th>
              <Th className="text-right">Estoque</Th>
              <Th className="text-right">Mínimo</Th>
              <Th>Situação</Th>
            </tr>
          </thead>
          <tbody>
            {query.data?.items.map((v) => (
              <tr key={v.id}>
                <Td>
                  <Link to={`/produtos/${v.productId}`} className="font-medium hover:underline">
                    {v.sku}
                  </Link>
                </Td>
                <Td>{[v.size, v.color].filter(Boolean).join(' / ') || '—'}</Td>
                <Td className="text-right tabular-nums">{v.stock}</Td>
                <Td className="text-right tabular-nums text-muted-foreground">{v.minStock}</Td>
                <Td>
                  <StockBadge stock={v.stock} min={v.minStock} />
                </Td>
              </tr>
            ))}
            {query.data?.items.length === 0 && (
              <tr>
                <Td colSpan={5} className="py-10 text-center text-muted-foreground">
                  Nenhuma variante abaixo do mínimo.
                </Td>
              </tr>
            )}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
