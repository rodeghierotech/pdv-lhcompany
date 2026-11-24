/**
 * Regras puras de cálculo de vendas (sem I/O). Usadas pela API como fonte de verdade e pela UI
 * apenas para PRÉVIA — o servidor sempre recalcula e valida.
 * Todo valor é inteiro em centavos.
 */

export const PAYMENT_METHODS = ['dinheiro', 'pix', 'debito', 'credito'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  dinheiro: 'Dinheiro',
  pix: 'PIX',
  debito: 'Débito',
  credito: 'Crédito',
};

export const SALE_STATUSES = ['concluida', 'cancelada', 'devolvida'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

export const PAYMENT_STATUSES = ['pago', 'parcial', 'fiado'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Limites físicos: mantêm todos os valores dentro de `integer` do PostgreSQL e de Number.MAX_SAFE_INTEGER. */
export const MAX_ITEM_QUANTITY = 1000;
export const MAX_SALE_SUBTOTAL_CENTS = 1_000_000_000;

export interface LineInput {
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
}

export function lineGrossCents(line: Pick<LineInput, 'quantity' | 'unitPriceCents'>): number {
  return line.quantity * line.unitPriceCents;
}

export function lineTotalCents(line: LineInput): number {
  return lineGrossCents(line) - line.discountCents;
}

export interface SaleTotals {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}

export function computeSaleTotals(lines: readonly LineInput[]): SaleTotals {
  let subtotalCents = 0;
  let discountCents = 0;
  for (const line of lines) {
    subtotalCents += lineGrossCents(line);
    discountCents += line.discountCents;
  }
  return { subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
}

/** Desconto total cabe no limite do papel? (compara em inteiros: sem erro de ponto flutuante) */
export function isDiscountWithinLimit(
  discountCents: number,
  subtotalCents: number,
  maxDiscountBp: number,
): boolean {
  return discountCents * 10_000 <= maxDiscountBp * subtotalCents;
}

/** Converte percentual (em pontos-base, 1000 = 10%) em centavos sobre um valor bruto, arredondando. */
export function percentToCents(grossCents: number, basisPoints: number): number {
  return Math.round((grossCents * basisPoints) / 10_000);
}

/**
 * Estado do pagamento. `dueCents` = total efetivo (após devoluções) menos o líquido recebido.
 * - pago: nada a receber
 * - fiado: nada foi pago ainda
 * - parcial: pago parte, resta saldo
 */
export function paymentStatusOf(
  totalCents: number,
  returnedCents: number,
  receivedCents: number,
): PaymentStatus {
  const due = totalCents - returnedCents - receivedCents;
  if (due <= 0) return 'pago';
  return receivedCents <= 0 ? 'fiado' : 'parcial';
}

export function balanceOf(
  totalCents: number,
  returnedCents: number,
  receivedCents: number,
): number {
  return Math.max(totalCents - returnedCents - receivedCents, 0);
}

/**
 * Valor devolvido de um item de forma acumulada: floor(total * qtd / qtdTotal).
 * A diferença entre acumulados garante que a soma de várias devoluções parciais nunca passe do
 * total da linha e que, na devolução da última unidade, o total seja devolvido exatamente.
 */
export function cumulativeReturnCents(
  lineTotal: number,
  lineQuantity: number,
  returnedQuantity: number,
): number {
  return Math.floor((lineTotal * returnedQuantity) / lineQuantity);
}

export function returnItemAmountCents(
  lineTotal: number,
  lineQuantity: number,
  alreadyReturnedQuantity: number,
  returnQuantity: number,
): number {
  return (
    cumulativeReturnCents(lineTotal, lineQuantity, alreadyReturnedQuantity + returnQuantity) -
    cumulativeReturnCents(lineTotal, lineQuantity, alreadyReturnedQuantity)
  );
}

export interface ReturnEffect {
  /** Valor total dos itens devolvidos. */
  valueCents: number;
  /** Dinheiro a devolver ao cliente (exige reembolso registrado). */
  refundDueCents: number;
  /** Parte do valor que abate o saldo devedor do cliente (fiado), sem movimentar dinheiro. */
  debtReductionCents: number;
}

/**
 * Efeito financeiro de uma devolução: primeiro abate o saldo devedor; só o excedente do que o
 * cliente já pagou precisa ser reembolsado.
 */
export function computeReturnEffect(params: {
  totalCents: number;
  returnedBeforeCents: number;
  receivedCents: number;
  valueCents: number;
}): ReturnEffect {
  const { totalCents, returnedBeforeCents, receivedCents, valueCents } = params;
  const balanceBefore = balanceOf(totalCents, returnedBeforeCents, receivedCents);
  const effectiveAfter = totalCents - returnedBeforeCents - valueCents;
  const balanceAfter = Math.max(effectiveAfter - receivedCents, 0);
  return {
    valueCents,
    refundDueCents: Math.max(receivedCents - effectiveAfter, 0),
    debtReductionCents: balanceBefore - balanceAfter,
  };
}
