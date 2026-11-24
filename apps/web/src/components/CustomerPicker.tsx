import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, UserPlus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { formatBRL } from '@pdv/shared';
import type { CustomerDTO, Paginated } from '@pdv/shared';
import { ErrorNotice } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { api } from '@/lib/api';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/** Seleção opcional de cliente (obrigatória para fiado/parcial). Permite cadastro rápido. */
export function CustomerPicker({
  value,
  onChange,
  required,
}: {
  value: CustomerDTO | null;
  onChange: (customer: CustomerDTO | null) => void;
  required: boolean;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const q = useDebounced(search.trim(), 250);

  const results = useQuery({
    queryKey: ['customers', { q }],
    queryFn: () => api<Paginated<CustomerDTO>>('/customers', { query: { q, pageSize: 6 } }),
    enabled: !value && q.length >= 2,
  });

  const create = useMutation({
    mutationFn: (body: unknown) =>
      api<{ customer: CustomerDTO }>('/customers', { method: 'POST', body }),
    onSuccess: ({ customer }) => {
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      onChange(customer);
      setCreating(false);
      setNewName('');
      setNewPhone('');
      setSearch('');
    },
  });

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{value.name}</p>
          <p className="text-xs text-muted-foreground">
            Débito atual: {formatBRL(value.debtCents)}
            {value.creditLimitCents !== null && ` · limite ${formatBRL(value.creditLimitCents)}`}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Remover cliente"
          onClick={() => onChange(null)}
        >
          <X />
        </Button>
      </div>
    );
  }

  function onCreate(e: FormEvent) {
    e.preventDefault();
    if (newName.trim().length < 2) return;
    create.mutate({ name: newName.trim(), ...(newPhone.trim() ? { phone: newPhone.trim() } : {}) });
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
        <Input
          aria-label="Buscar cliente"
          placeholder={
            required
              ? 'Cliente (obrigatório para fiado)'
              : 'Cliente (opcional) — nome, telefone ou CPF'
          }
          className="pl-9"
          aria-invalid={required || undefined}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {results.data && results.data.items.length > 0 && (
        <ul className="divide-y rounded-md border bg-card">
          {results.data.items.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                onClick={() => {
                  onChange(c);
                  setSearch('');
                }}
              >
                <span className="truncate">{c.name}</span>
                {c.debtCents > 0 && (
                  <span className="shrink-0 text-xs text-warning">
                    deve {formatBRL(c.debtCents)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {results.data && results.data.items.length === 0 && q.length >= 2 && (
        <p className="text-xs text-muted-foreground">Nenhum cliente encontrado.</p>
      )}
      {creating ? (
        <form onSubmit={onCreate} className="space-y-2 rounded-md border bg-card p-3">
          <Field label="Nome *" htmlFor="new-customer-name">
            <Input
              id="new-customer-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Telefone" htmlFor="new-customer-phone">
            <Input
              id="new-customer-phone"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
            />
          </Field>
          <ErrorNotice error={create.error} />
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={create.isPending || newName.trim().length < 2}
            >
              Cadastrar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
          <UserPlus /> Novo cliente
        </Button>
      )}
    </div>
  );
}
