import { Plus, Trash2 } from 'lucide-react';
import { PAYMENT_METHOD_LABEL, PAYMENT_METHODS, parseBRLToCents } from '@pdv/shared';
import type { PaymentMethod } from '@pdv/shared';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import { centsToInput } from '@/lib/variantForm';

export interface PayRow {
  id: string;
  method: PaymentMethod;
  amount: string;
}

export const newPayRow = (method: PaymentMethod, cents: number): PayRow => ({
  id: crypto.randomUUID(),
  method,
  amount: cents > 0 ? centsToInput(cents) : '',
});

export function sumPayRows(rows: PayRow[]): { sum: number; valid: boolean } {
  const cents = rows.map((r) => (r.amount.trim() === '' ? null : parseBRLToCents(r.amount)));
  return {
    sum: cents.reduce<number>((s, c) => s + (c ?? 0), 0),
    valid: rows.length > 0 && cents.every((c) => c !== null && c > 0),
  };
}

/** Linhas de forma de pagamento (misto): usado no recebimento de fiado. */
export function PaymentRowsEditor({
  rows,
  onChange,
  totalCents,
}: {
  rows: PayRow[];
  onChange: (rows: PayRow[]) => void;
  totalCents: number;
}) {
  const { sum } = sumPayRows(rows);
  const remaining = totalCents - sum;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-2">
        {PAYMENT_METHODS.map((m) => (
          <Button
            key={m}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange([newPayRow(m, totalCents)])}
          >
            {PAYMENT_METHOD_LABEL[m]}
          </Button>
        ))}
      </div>
      {rows.map((r, i) => (
        <div key={r.id} className="flex items-center gap-2">
          <Select
            aria-label={`Forma de pagamento ${i + 1}`}
            className="h-9 flex-1"
            value={r.method}
            onChange={(e) =>
              onChange(
                rows.map((x) =>
                  x.id === r.id ? { ...x, method: e.target.value as PaymentMethod } : x,
                ),
              )
            }
          >
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABEL[m]}
              </option>
            ))}
          </Select>
          <Input
            aria-label={`Valor ${i + 1}`}
            inputMode="decimal"
            placeholder="0,00"
            className="h-9 w-28 text-right"
            value={r.amount}
            onChange={(e) =>
              onChange(rows.map((x) => (x.id === r.id ? { ...x, amount: e.target.value } : x)))
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label={`Remover pagamento ${i + 1}`}
            onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onChange([...rows, newPayRow('pix', Math.max(remaining, 0))])}
      >
        <Plus /> Adicionar forma de pagamento
      </Button>
    </div>
  );
}

export const payRowsToInput = (rows: PayRow[]) =>
  rows.map((r) => ({ method: r.method, amountCents: parseBRLToCents(r.amount) as number }));
