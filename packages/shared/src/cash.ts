import type { PaymentMethod } from './sales.js';

export interface DebtSale {
  saleId: string;
  balanceCents: number;
}

export interface Allocation {
  saleId: string;
  method: PaymentMethod;
  amountCents: number;
}

/**
 * Distribui os pagamentos informados sobre as vendas em aberto, na ordem recebida (a API passa
 * as vendas da mais antiga para a mais nova). Cada pagamento é fatiado conforme o saldo de cada
 * venda. Retorna `null` se o total pago ultrapassar o saldo devido (nunca aceita sobra).
 * Função pura: o total alocado é sempre exatamente o total pago.
 */
export function allocateReceipt(
  payments: { method: PaymentMethod; amountCents: number }[],
  sales: DebtSale[],
): Allocation[] | null {
  const remaining = sales.map((s) => ({ saleId: s.saleId, left: s.balanceCents }));
  const out: Allocation[] = [];
  let i = 0;
  for (const payment of payments) {
    let toPlace = payment.amountCents;
    while (toPlace > 0) {
      while (i < remaining.length && remaining[i]!.left <= 0) i += 1;
      const target = remaining[i];
      if (!target) return null;
      const part = Math.min(toPlace, target.left);
      out.push({ saleId: target.saleId, method: payment.method, amountCents: part });
      target.left -= part;
      toPlace -= part;
    }
  }
  return out;
}
