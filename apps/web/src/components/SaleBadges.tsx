import type { PaymentStatus, SaleStatus } from '@pdv/shared';
import { Badge } from '@/components/ui/display';

export const SALE_STATUS_LABEL: Record<SaleStatus, string> = {
  concluida: 'Concluída',
  cancelada: 'Cancelada',
  devolvida: 'Devolvida',
};
export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pago: 'Pago',
  parcial: 'Parcial',
  fiado: 'Fiado',
};

export function SaleStatusBadge({ status }: { status: SaleStatus }) {
  return (
    <Badge
      variant={
        status === 'concluida' ? 'success' : status === 'cancelada' ? 'destructive' : 'secondary'
      }
    >
      {SALE_STATUS_LABEL[status]}
    </Badge>
  );
}

export function PaymentStatusBadge({ status }: { status: PaymentStatus | null }) {
  if (!status) return null;
  return (
    <Badge variant={status === 'pago' ? 'success' : 'warning'}>
      {PAYMENT_STATUS_LABEL[status]}
    </Badge>
  );
}
