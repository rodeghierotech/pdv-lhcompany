import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/display';
import { Input } from '@/components/ui/form';
import { describeApiError } from '@/lib/errors';

export function StockBadge({ stock, min }: { stock: number; min: number }) {
  if (stock <= 0) return <Badge variant="destructive">Zerado</Badge>;
  if (stock <= min) return <Badge variant="warning">Baixo</Badge>;
  return <Badge variant="success">OK</Badge>;
}

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="flex gap-2">{actions}</div>
    </div>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const message = describeApiError(error);
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
    >
      {message}
    </p>
  );
}

/** Campo monetário: o usuário digita "12,50"; o valor convertido para centavos é validado no envio. */
export function MoneyInput(props: React.ComponentProps<typeof Input>) {
  return <Input inputMode="decimal" placeholder="0,00" {...props} />;
}
