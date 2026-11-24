import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { formatBRL, parseBRLToCents } from '@pdv/shared';
import type { CustomerDTO, Paginated } from '@pdv/shared';
import { ErrorNotice, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Badge, Card, Table, Td, Th } from '@/components/ui/display';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';
import { centsToInput } from '@/lib/variantForm';

/** Cria ou edita cliente. Limite de crédito só aparece para quem tem `customer:credit`. */
export function CustomerFormDialog({
  customer,
  onClose,
}: {
  customer?: CustomerDTO;
  onClose: () => void;
}) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState(customer?.name ?? '');
  const [document, setDocument] = useState(customer?.document ?? '');
  const [phone, setPhone] = useState(customer?.phone ?? '');
  const [limit, setLimit] = useState(
    customer?.creditLimitCents != null ? centsToInput(customer.creditLimitCents) : '',
  );
  const [active, setActive] = useState(customer?.active ?? true);
  const limitCents = limit.trim() === '' ? null : parseBRLToCents(limit);
  const limitInvalid = limit.trim() !== '' && limitCents === null;
  const canCredit = can('customer:credit');

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        document: document.trim() || null,
        phone: phone.trim() || null,
        ...(canCredit ? { creditLimitCents: limitCents } : {}),
        ...(customer ? { active } : {}),
      };
      return customer
        ? api<{ customer: CustomerDTO }>(`/customers/${customer.id}`, { method: 'PATCH', body })
        : api<{ customer: CustomerDTO }>('/customers', {
            method: 'POST',
            body: {
              name: body.name,
              ...(body.document ? { document: body.document } : {}),
              ...(body.phone ? { phone: body.phone } : {}),
              ...(canCredit && limitCents !== null ? { creditLimitCents: limitCents } : {}),
            },
          });
    },
    onSuccess: () => {
      toast.success(customer ? 'Cliente atualizado' : 'Cliente cadastrado');
      for (const k of ['customers', 'customer', 'customer-account'])
        void queryClient.invalidateQueries({ queryKey: [k] });
      onClose();
    },
  });

  return (
    <DialogContent title={customer ? 'Editar cliente' : 'Novo cliente'}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim().length >= 2 && !limitInvalid) save.mutate();
        }}
      >
        <Field label="Nome *" htmlFor="c-name">
          <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="CPF/CNPJ" htmlFor="c-doc">
            <Input id="c-doc" value={document} onChange={(e) => setDocument(e.target.value)} />
          </Field>
          <Field label="Telefone" htmlFor="c-phone">
            <Input id="c-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>
        {canCredit && (
          <Field
            label="Limite de crédito (R$)"
            htmlFor="c-limit"
            hint="Vazio = sem limite."
            error={limitInvalid ? 'Valor inválido' : undefined}
          >
            <Input
              id="c-limit"
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </Field>
        )}
        {customer && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{' '}
            Cliente ativo
          </label>
        )}
        <ErrorNotice error={save.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button type="submit" disabled={name.trim().length < 2 || limitInvalid || save.isPending}>
            Salvar
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

export function CustomersPage() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const query = { q: q.trim() || undefined, page, pageSize: 20 };
  const { data, error } = useQuery({
    queryKey: ['customers', query],
    queryFn: () => api<Paginated<CustomerDTO>>('/customers', { query }),
    placeholderData: keepPreviousData,
  });
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <>
      <PageHeader
        title="Clientes"
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/fiado">Fiado em aberto</Link>
            </Button>
            {can('customer:write') && (
              <Button onClick={() => setCreating(true)}>
                <Plus /> Novo cliente
              </Button>
            )}
          </>
        }
      />
      <Input
        aria-label="Buscar cliente"
        placeholder="Nome, telefone ou CPF"
        className="mb-4 max-w-sm"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setPage(1);
        }}
      />
      <ErrorNotice error={error} />
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Nome</Th>
              <Th>Telefone</Th>
              <Th className="text-right">Débito</Th>
              <Th className="text-right">Vencido</Th>
              <Th className="text-right">Limite</Th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((c) => (
              <tr key={c.id} className="hover:bg-accent/50">
                <Td>
                  <Link
                    className="font-medium underline-offset-2 hover:underline"
                    to={`/clientes/${c.id}`}
                  >
                    {c.name}
                  </Link>
                  {!c.active && (
                    <Badge variant="secondary" className="ml-2">
                      Inativo
                    </Badge>
                  )}
                </Td>
                <Td>{c.phone ?? '—'}</Td>
                <Td className="text-right tabular-nums">
                  {c.debtCents > 0 ? formatBRL(c.debtCents) : '—'}
                </Td>
                <Td
                  className={`text-right tabular-nums ${c.overdueCents > 0 ? 'font-semibold text-destructive' : ''}`}
                >
                  {c.overdueCents > 0 ? formatBRL(c.overdueCents) : '—'}
                </Td>
                <Td className="text-right tabular-nums">
                  {c.creditLimitCents === null ? 'Sem limite' : formatBRL(c.creditLimitCents)}
                </Td>
              </tr>
            ))}
            {data && data.items.length === 0 && (
              <tr>
                <Td colSpan={5} className="py-8 text-center text-muted-foreground">
                  Nenhum cliente encontrado.
                </Td>
              </tr>
            )}
          </tbody>
        </Table>
      </Card>
      {data && data.total > data.pageSize && (
        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Página {page} de {totalPages} · {data.total} clientes
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
      <Dialog open={creating} onOpenChange={setCreating}>
        {creating && <CustomerFormDialog onClose={() => setCreating(false)} />}
      </Dialog>
    </>
  );
}
