import { z } from 'zod';
import { dateOnly } from './schemas.js';
import type { LedgerEntryType, MethodAmountDTO } from './schemas.js';

export const MAX_REPORT_DAYS = 366;

/** Dias entre duas datas AAAA-MM-DD (inclusive nas duas pontas). */
export function daysInRange(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Período do relatório (datas no fuso da loja). Ausente = hoje. */
export const reportRangeSchema = z
  .object({ from: dateOnly.optional(), to: dateOnly.optional() })
  .superRefine((v, ctx) => {
    if (v.from && v.to) {
      const days = daysInRange(v.from, v.to);
      if (days < 1)
        ctx.addIssue({ code: 'custom', path: ['to'], message: 'Fim anterior ao início' });
      if (days > MAX_REPORT_DAYS) {
        ctx.addIssue({
          code: 'custom',
          path: ['to'],
          message: `Período máximo de ${MAX_REPORT_DAYS} dias`,
        });
      }
    }
  });
export type ReportRange = z.infer<typeof reportRangeSchema>;

export const topProductsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(10) })
  .and(reportRangeSchema);

export interface ReportSummaryDTO {
  period: { from: string; to: string };
  /** Faturamento = vendas feitas no período (competência), pagas ou não. NÃO é dinheiro recebido. */
  sales: {
    grossCents: number;
    count: number;
    discountCents: number;
    /** Vendas não canceladas (base do ticket médio). */
    validCount: number;
    validCents: number;
    ticketAverageCents: number;
    /** Cancelamentos e devoluções ocorridos no período (pela data do evento). */
    cancelledCount: number;
    cancelledCents: number;
    returnsCount: number;
    returnsCents: number;
    /** bruto − cancelamentos − devoluções. */
    netCents: number;
  };
  /** Recebimento = dinheiro/PIX/cartão que efetivamente entrou (vendas + fiado), por modalidade. */
  receipts: {
    byMethod: MethodAmountDTO[];
    salesCents: number;
    debtCents: number;
    refundedCents: number;
    netCents: number;
  };
  expenses: {
    totalCents: number;
    reversedCents: number;
    netCents: number;
    byCategory: { category: string; netCents: number }[];
  };
  /** Posição atual (não depende do período). */
  openDebts: {
    totalCents: number;
    salesCount: number;
    customersCount: number;
    overdueCents: number;
  };
  cash: {
    openSessions: number;
    openExpectedCents: number;
    closedSessions: number;
    shortageCents: number;
    surplusCents: number;
  };
  lowStockCount: number;
}

export interface DailyPointDTO {
  date: string;
  grossCents: number;
  salesCount: number;
  adjustmentsCents: number;
  receivedNetCents: number;
}

export interface TopProductDTO {
  variantId: string;
  sku: string;
  productName: string;
  size: string | null;
  color: string | null;
  quantity: number;
  revenueCents: number;
}

export interface SellerReportDTO {
  sellerId: string;
  sellerName: string;
  salesCount: number;
  salesCents: number;
  discountCents: number;
  ticketAverageCents: number;
}

export interface RecentMovementDTO {
  id: string;
  type: LedgerEntryType;
  at: string;
  amountCents: number;
  method: string | null;
  operatorName: string | null;
  description: string | null;
  saleId: string | null;
  saleNumber: number | null;
}

/**
 * Célula de CSV segura: neutraliza injeção de fórmula (=, +, -, @, tab, CR) em planilhas
 * e protege separador/aspas/quebras de linha.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvRow = (cells: (string | number | null | undefined)[]): string =>
  cells.map(csvCell).join(';');

/** Valor monetário para CSV pt-BR (ex.: 12345 → "123,45"). Números sempre saem sem proteção de fórmula. */
export function csvMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}
