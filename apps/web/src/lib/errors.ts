import { formatBRL } from '@pdv/shared';
import { ApiError } from '@/lib/api';

interface StockDetail {
  sku: string;
  requested: number;
  available: number;
}

/** Mensagem acionável para o operador a partir do erro da API (códigos de negócio da Fase 5). */
export function describeApiError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Ocorreu um erro inesperado. Tente novamente.';
  if (error.isNetwork) return 'Sem conexão com o servidor. Verifique a internet e tente novamente.';
  const d = error.details;
  switch (error.code) {
    case 'INSUFFICIENT_STOCK':
      if (Array.isArray(d)) {
        return (
          'Estoque insuficiente: ' +
          (d as StockDetail[])
            .map((s) => `${s.sku} (pedido ${s.requested}, disponível ${s.available})`)
            .join('; ')
        );
      }
      return error.message;
    case 'CREDIT_LIMIT_EXCEEDED': {
      const x = d as { availableCents: number; requestedCents: number } | undefined;
      return x
        ? `Limite de crédito excedido: saldo a lançar ${formatBRL(x.requestedCents)}, disponível ${formatBRL(x.availableCents)}.`
        : error.message;
    }
    case 'REFUND_MISMATCH': {
      const x = d as { expectedRefundCents: number } | undefined;
      return x
        ? `O reembolso deve somar exatamente ${formatBRL(x.expectedRefundCents)}.`
        : error.message;
    }
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'Esta operação já foi registrada com dados diferentes. Confira o histórico de vendas antes de repetir.';
    default:
      return error.message;
  }
}
