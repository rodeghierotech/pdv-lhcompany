import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CategoryDTO, Paginated, ProductDTO } from '@pdv/shared';
import { ErrorNotice, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Badge, Card, Table, Td, Th } from '@/components/ui/display';
import { Input, Select } from '@/components/ui/form';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function ProductsPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(search.trim(), 250);

  useEffect(() => setPage(1), [q, categoryId]);

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api<{ items: CategoryDTO[] }>('/categories'),
  });
  const products = useQuery({
    queryKey: ['products', { q, categoryId, page }],
    queryFn: () =>
      api<Paginated<ProductDTO>>('/products', { query: { q, categoryId, page, pageSize: 20 } }),
    placeholderData: keepPreviousData,
  });

  const data = products.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageHeader
        title="Produtos"
        actions={
          can('product:write') && (
            <Button asChild>
              <Link to="/produtos/novo">
                <Plus /> Novo produto
              </Link>
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
          <Input
            aria-label="Buscar produtos"
            placeholder="Buscar por nome, SKU ou código de barras"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>
        <Select
          aria-label="Categoria"
          className="sm:w-56"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">Todas as categorias</option>
          {categories.data?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>

      <ErrorNotice error={products.error} />
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Produto</Th>
              <Th>Categoria</Th>
              <Th className="text-right">Variantes</Th>
              <Th className="text-right">Estoque</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((p) => (
              <tr key={p.id} className="hover:bg-accent/50">
                <Td>
                  <Link to={`/produtos/${p.id}`} className="font-medium hover:underline">
                    {p.name}
                  </Link>
                </Td>
                <Td className="text-muted-foreground">{p.categoryName ?? '—'}</Td>
                <Td className="text-right tabular-nums">{p.variants.length}</Td>
                <Td className="text-right tabular-nums">
                  {p.variants.reduce((sum, v) => sum + v.stock, 0)}
                </Td>
                <Td>
                  {p.active ? (
                    <Badge variant="success">Ativo</Badge>
                  ) : (
                    <Badge variant="secondary">Inativo</Badge>
                  )}
                </Td>
              </tr>
            ))}
            {data && data.items.length === 0 && (
              <tr>
                <Td colSpan={5} className="py-10 text-center text-muted-foreground">
                  Nenhum produto encontrado.
                </Td>
              </tr>
            )}
            {!data && products.isLoading && (
              <tr>
                <Td colSpan={5} className="py-10 text-center text-muted-foreground">
                  Carregando…
                </Td>
              </tr>
            )}
          </tbody>
        </Table>
      </Card>

      {data && data.total > data.pageSize && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Página {page} de {totalPages} · {data.total} produtos
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
