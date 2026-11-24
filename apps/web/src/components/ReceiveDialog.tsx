import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { formatBRL } from '@pdv/shared';
import type { DebtReceiptDTO } from '@pdv/shared';
import {
  PaymentRowsEditor,
  newPayRow,
  payRowsToInput,
  sumPayRows,
} from '@/components/PaymentRowsEditor';
import { ErrorNotice } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { api } from '@/lib/api';
import { newIdempotencyKey } from '@/lib/utils';

export function invalidateFinance(queryClient: ReturnType<typeof useQueryClient>) {
  for (const key of [
    'sales',
    'sale',
    'customers',
    'customer',
    'customer-account',
    'customer-payments',
    'debts',
    'cash',
  ]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

/** Recebimento posterior: do saldo geral do cliente (saleId ausente) ou de uma venda específica. */
export function ReceiveDialog({
  customerId,
  customerName,
  saleId,
  saleNumber,
  balanceCents,
  onClose,
}: {
  customerId: string;
  customerName: string;
  saleId?: string;
  saleNumber?: number;
  balanceCents: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState(() => [newPayRow('dinheiro', balanceCents)]);
  const [note, setNote] = useState('');
  const key = useRef(newIdempotencyKey());
  const { sum, valid } = sumPayRows(rows);
  const over = sum > balanceCents;

  const receive = useMutation({
    mutationFn: () =>
      api<{ receipt: DebtReceiptDTO }>(
        saleId ? `/sales/${saleId}/receipts` : `/customers/${customerId}/receipts`,
        {
          method: 'POST',
          body: {
            idempotencyKey: key.current,
            payments: payRowsToInput(rows),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        },
      ),
    onSuccess: ({ receipt }) => {
      toast.success(
        `Recebimento #${receipt.number} de ${formatBRL(receipt.totalCents)} registrado`,
      );
      invalidateFinance(queryClient);
      onClose();
    },
  });

  const left = balanceCents - sum;
  return (
    <DialogContent
      title={saleNumber ? `Receber — venda #${saleNumber}` : `Receber de ${customerName}`}
      description={`Saldo devido: ${formatBRL(balanceCents)}. ${saleId ? '' : 'O valor abate as vendas mais antigas primeiro.'}`}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !over) receive.mutate();
        }}
      >
        <PaymentRowsEditor rows={rows} onChange={setRows} totalCents={balanceCents} />
        <div className="flex justify-between rounded-md bg-muted px-3 py-2 text-sm">
          <span>
            Recebendo <strong className="tabular-nums">{formatBRL(sum)}</strong>
          </span>
          <span className={over ? 'text-destructive' : left > 0 ? 'text-warning' : 'text-success'}>
            {over
              ? `Excede o saldo em ${formatBRL(-left)}`
              : left > 0
                ? `Saldo restante ${formatBRL(left)}`
                : 'Quita a dívida'}
          </span>
        </div>
        <Field label="Observação" htmlFor="receive-note">
          <Input id="receive-note" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorNotice error={receive.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button type="submit" disabled={!valid || over || receive.isPending}>
            {receive.isPending ? 'Registrando…' : 'Confirmar recebimento'}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
