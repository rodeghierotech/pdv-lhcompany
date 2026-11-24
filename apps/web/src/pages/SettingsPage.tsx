import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import type { DiscountLimitDTO } from '@pdv/shared';
import { ErrorNotice, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/display';
import { Input } from '@/components/ui/form';
import { api } from '@/lib/api';

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrador',
  gerente: 'Gerente',
  vendedor: 'Vendedor',
};

function LimitRow({ item }: { item: DiscountLimitDTO }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(String(item.maxDiscountBp / 100).replace('.', ','));
  const pct = Number(text.replace(',', '.'));
  const valid = text.trim() !== '' && Number.isFinite(pct) && pct >= 0 && pct <= 100;
  const save = useMutation({
    mutationFn: () =>
      api(`/settings/discount-limits/${item.role}`, {
        method: 'PUT',
        body: { maxDiscountBp: Math.round(pct * 100) },
      }),
    onSuccess: () => {
      toast.success('Limite salvo');
      void queryClient.invalidateQueries({ queryKey: ['discount-limits'] });
    },
  });
  return (
    <li className="space-y-1 py-3">
      <div className="flex items-center gap-3">
        <label htmlFor={`limit-${item.role}`} className="w-32 text-sm font-medium">
          {ROLE_LABEL[item.role] ?? item.role}
        </label>
        <Input
          id={`limit-${item.role}`}
          inputMode="decimal"
          className="h-9 w-24 text-right"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <span className="text-sm text-muted-foreground">%</span>
        <Button
          size="sm"
          disabled={!valid || save.isPending || Math.round(pct * 100) === item.maxDiscountBp}
          onClick={() => save.mutate()}
        >
          Salvar
        </Button>
      </div>
      <ErrorNotice error={save.error} />
    </li>
  );
}

export function SettingsPage() {
  const { data, error } = useQuery({
    queryKey: ['discount-limits'],
    queryFn: () => api<{ items: DiscountLimitDTO[] }>('/settings/discount-limits'),
  });
  return (
    <>
      <PageHeader title="Configurações" />
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Desconto máximo por perfil</CardTitle>
          <p className="text-sm text-muted-foreground">0% impede o perfil de conceder desconto.</p>
        </CardHeader>
        <CardContent>
          <ErrorNotice error={error} />
          <ul className="divide-y">
            {data?.items.map((i) => (
              <LimitRow key={`${i.role}-${i.maxDiscountBp}`} item={i} />
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
