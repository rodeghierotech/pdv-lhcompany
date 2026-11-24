import { z } from 'zod';
import { ROLES } from './permissions.js';
import {
  MAX_ITEM_QUANTITY,
  MAX_SALE_SUBTOTAL_CENTS,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  SALE_STATUSES,
} from './sales.js';
import type { PaymentMethod, PaymentStatus, SaleStatus } from './sales.js';

const cents = z.number().int().min(0).max(99_999_999);
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);
const optionalText = (max: number) =>
  z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());

// ---------- Auth ----------
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const userCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(10).max(200),
  role: z.enum(ROLES),
});
export type UserCreateInput = z.infer<typeof userCreateSchema>;

// ---------- Catálogo ----------
export const categoryCreateSchema = z.object({ name: z.string().trim().min(2).max(80) });
export type CategoryCreateInput = z.infer<typeof categoryCreateSchema>;

const sku = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._\-/]+$/, 'SKU aceita letras, números e . _ - /');

export const variantCreateSchema = z.object({
  sku,
  barcode: optionalText(64),
  size: optionalText(20),
  color: optionalText(40),
  priceCents: cents,
  costCents: cents.default(0),
  minStock: z.number().int().min(0).max(100_000).default(0),
  /** Estoque inicial (gera lote + movimentação de entrada). */
  initialStock: z.number().int().min(0).max(1_000_000).default(0),
});
export type VariantCreateInput = z.infer<typeof variantCreateSchema>;

export const variantUpdateSchema = z
  .object({
    sku,
    barcode: z.string().trim().max(64).nullable(),
    size: z.string().trim().max(20).nullable(),
    color: z.string().trim().max(40).nullable(),
    priceCents: cents,
    costCents: cents,
    minStock: z.number().int().min(0).max(100_000),
    active: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nenhum campo para atualizar');
export type VariantUpdateInput = z.infer<typeof variantUpdateSchema>;

export const productCreateSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: optionalText(1000),
  categoryId: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  variants: z.array(variantCreateSchema).min(1).max(100),
  idempotencyKey: z.string().min(8).max(100),
});
export type ProductCreateInput = z.infer<typeof productCreateSchema>;

export const productUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(160),
    description: z.string().trim().max(1000).nullable(),
    categoryId: z.string().uuid().nullable(),
    active: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nenhum campo para atualizar');
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

export const productListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: z.string().uuid().optional(),
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  ...pagination,
});
export type ProductListQuery = z.infer<typeof productListQuerySchema>;

// ---------- Estoque ----------
export const MOVEMENT_TYPES = [
  'entrada',
  'ajuste',
  'venda',
  'devolucao',
  'estorno',
  'pedido_online',
  'estorno_pedido_online',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

const idempotencyKey = z.string().min(8).max(100);

export const stockEntrySchema = z.object({
  variantId: z.string().uuid(),
  quantity: z.number().int().min(1).max(1_000_000),
  unitCostCents: cents.optional(),
  note: optionalText(300),
  idempotencyKey,
});
export type StockEntryInput = z.infer<typeof stockEntrySchema>;

export const stockAdjustSchema = z.object({
  variantId: z.string().uuid(),
  delta: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((v) => v !== 0, 'A variação não pode ser zero'),
  reason: z.string().trim().min(3).max(300),
  idempotencyKey,
});
export type StockAdjustInput = z.infer<typeof stockAdjustSchema>;

export const stockReverseSchema = z.object({
  reason: z.string().trim().min(3).max(300),
  idempotencyKey,
});
export type StockReverseInput = z.infer<typeof stockReverseSchema>;

export const movementListQuerySchema = z.object({
  variantId: z.string().uuid().optional(),
  ...pagination,
});
export type MovementListQuery = z.infer<typeof movementListQuerySchema>;

// ---------- DTOs de resposta ----------
export interface UserDTO {
  id: string;
  name: string;
  email: string;
  role: (typeof ROLES)[number];
}

export interface CategoryDTO {
  id: string;
  name: string;
}

export interface VariantDTO {
  id: string;
  productId: string;
  sku: string;
  barcode: string | null;
  size: string | null;
  color: string | null;
  priceCents: number;
  costCents: number;
  minStock: number;
  active: boolean;
  stock: number;
}

export interface ProductDTO {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  active: boolean;
  variants: VariantDTO[];
}

export interface StockMovementDTO {
  id: string;
  variantId: string;
  sku: string;
  type: MovementType;
  quantityDelta: number;
  reason: string | null;
  reversesMovementId: string | null;
  createdAt: string;
  actorName: string | null;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

// ---------- Clientes ----------
const documentField = z.preprocess(
  (v) => (typeof v === 'string' ? v.replace(/\D/g, '') || undefined : v),
  z
    .string()
    .regex(/^(\d{11}|\d{14})$/, 'Documento deve ter 11 (CPF) ou 14 (CNPJ) dígitos')
    .optional(),
);

export const customerCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  document: documentField,
  phone: optionalText(30),
  /** null/ausente = sem limite de crédito. */
  creditLimitCents: cents.nullable().optional(),
});
export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;

export const customerUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    document: z.string().trim().max(20).nullable(),
    phone: z.string().trim().max(30).nullable(),
    creditLimitCents: cents.nullable(),
    active: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nenhum campo para atualizar');
export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;

export const customerListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  ...pagination,
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

// ---------- Configurações: limite de desconto por papel ----------
export const discountLimitUpdateSchema = z.object({
  /** Pontos-base: 0 = sem desconto, 1000 = 10%, 10000 = 100%. */
  maxDiscountBp: z.number().int().min(0).max(10_000),
});
export type DiscountLimitUpdateInput = z.infer<typeof discountLimitUpdateSchema>;

// ---------- Vendas ----------
export const saleItemInputSchema = z.object({
  variantId: z.string().uuid(),
  quantity: z.number().int().min(1).max(MAX_ITEM_QUANTITY),
  /** Preço visto pelo operador: o servidor recusa se o preço vigente for outro. */
  unitPriceCents: cents,
  discountCents: cents.default(0),
});
export type SaleItemInput = z.infer<typeof saleItemInputSchema>;

export const paymentInputSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amountCents: z.number().int().min(1).max(MAX_SALE_SUBTOTAL_CENTS),
});
export type PaymentInput = z.infer<typeof paymentInputSchema>;

/** Data real do calendário (rejeita 2026-02-30, que o JS aceitaria rolando para março). */
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve ser AAAA-MM-DD')
  .refine(isRealDate, 'Data inexistente');

const uniqueBy = <T>(items: T[], key: (item: T) => string) =>
  new Set(items.map(key)).size === items.length;

export const saleCreateSchema = z.object({
  idempotencyKey,
  customerId: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  note: optionalText(300),
  items: z
    .array(saleItemInputSchema)
    .min(1)
    .max(100)
    .refine(
      (items) => uniqueBy(items, (i) => i.variantId),
      'Variante repetida: some as quantidades',
    ),
  /** Vazio = venda inteira fiada (exige cliente). */
  payments: z.array(paymentInputSchema).max(10).default([]),
  /** Vencimento opcional do saldo (AAAA-MM-DD). Só vale com saldo a receber. */
  dueDate: z.preprocess(emptyToUndefined, dateOnly.optional()),
});
export type SaleCreateInput = z.infer<typeof saleCreateSchema>;

export const saleCancelSchema = z.object({
  reason: z.string().trim().min(3).max(300),
  idempotencyKey,
});
export type SaleCancelInput = z.infer<typeof saleCancelSchema>;

export const saleReturnItemSchema = z.object({
  saleItemId: z.string().uuid(),
  quantity: z.number().int().min(1).max(MAX_ITEM_QUANTITY),
});

const returnItems = z
  .array(saleReturnItemSchema)
  .min(1)
  .max(100)
  .refine((items) => uniqueBy(items, (i) => i.saleItemId), 'Item repetido na devolução');

export const saleReturnPreviewSchema = z.object({ items: returnItems });
export type SaleReturnPreviewInput = z.infer<typeof saleReturnPreviewSchema>;

export const saleReturnSchema = z.object({
  items: returnItems,
  /** Reembolso em dinheiro por forma de pagamento; deve somar exatamente o valor a devolver. */
  refunds: z.array(paymentInputSchema).max(10).default([]),
  reason: z.string().trim().min(3).max(300),
  idempotencyKey,
});
export type SaleReturnInput = z.infer<typeof saleReturnSchema>;

export const saleListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(SALE_STATUSES).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  customerId: z.string().uuid().optional(),
  /** Datas no formato AAAA-MM-DD, no fuso da loja (America/Sao_Paulo). */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  ...pagination,
});
export type SaleListQuery = z.infer<typeof saleListQuerySchema>;

export const variantSearchQuerySchema = z.object({ q: z.string().trim().min(1).max(100) });

// ---------- DTOs: vendas, clientes, configurações ----------
export interface CustomerDTO {
  id: string;
  name: string;
  document: string | null;
  phone: string | null;
  creditLimitCents: number | null;
  active: boolean;
  /** Saldo devedor atual (vendas não canceladas). */
  debtCents: number;
  /** Parte do saldo com vencimento já passado (vencimento é opcional e não bloqueia vendas). */
  overdueCents: number;
}

export interface DiscountLimitDTO {
  role: (typeof ROLES)[number];
  maxDiscountBp: number;
}

export interface SellableVariantDTO {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  barcode: string | null;
  size: string | null;
  color: string | null;
  priceCents: number;
  stock: number;
}

export interface SaleItemDTO {
  id: string;
  variantId: string;
  sku: string;
  productName: string;
  size: string | null;
  color: string | null;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  lineTotalCents: number;
  returnedQuantity: number;
}

export interface SalePaymentDTO {
  id: string;
  kind: 'recebimento' | 'estorno';
  method: PaymentMethod;
  amountCents: number;
  createdAt: string;
  /** Preenchido em recebimentos posteriores (fiado/saldo) e em seus estornos. */
  receiptId: string | null;
  receiptNumber: number | null;
  reversesPaymentId: string | null;
  /** Este pagamento já foi estornado. */
  reversed: boolean;
}

export interface SaleReturnDTO {
  id: string;
  reason: string;
  createdAt: string;
  createdByName: string | null;
  valueCents: number;
  items: { saleItemId: string; quantity: number; amountCents: number }[];
}

export interface SaleListItemDTO {
  id: string;
  number: number;
  createdAt: string;
  status: SaleStatus;
  paymentStatus: PaymentStatus | null;
  customerName: string | null;
  sellerName: string;
  totalCents: number;
  balanceCents: number;
}

export interface SaleDTO extends SaleListItemDTO {
  customerId: string | null;
  subtotalCents: number;
  discountCents: number;
  /** Líquido recebido (recebimentos − estornos). */
  receivedCents: number;
  returnedCents: number;
  note: string | null;
  dueDate: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  items: SaleItemDTO[];
  payments: SalePaymentDTO[];
  returns: SaleReturnDTO[];
}

export interface ReturnPreviewDTO {
  valueCents: number;
  refundDueCents: number;
  debtReductionCents: number;
}

// ---------- Caixa ----------
export const CASH_MOVEMENT_KINDS = ['sangria', 'suprimento', 'despesa'] as const;
export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[number];

export const cashOpenSchema = z.object({
  idempotencyKey,
  openingCents: z.number().int().min(0).max(MAX_SALE_SUBTOTAL_CENTS),
});
export type CashOpenInput = z.infer<typeof cashOpenSchema>;

export const cashCloseSchema = z.object({
  idempotencyKey,
  countedCents: z.number().int().min(0).max(MAX_SALE_SUBTOTAL_CENTS),
  /** Obrigatória quando há diferença entre o contado e o esperado. */
  note: optionalText(300),
});
export type CashCloseInput = z.infer<typeof cashCloseSchema>;

export const cashMovementSchema = z.object({
  idempotencyKey,
  kind: z.enum(CASH_MOVEMENT_KINDS),
  amountCents: z.number().int().min(1).max(MAX_SALE_SUBTOTAL_CENTS),
  description: z.string().trim().min(3).max(200),
  category: optionalText(60),
});
export type CashMovementInput = z.infer<typeof cashMovementSchema>;

export const cashMovementReverseSchema = z.object({
  idempotencyKey,
  reason: z.string().trim().min(3).max(300),
});
export type CashMovementReverseInput = z.infer<typeof cashMovementReverseSchema>;

export const cashSessionListQuerySchema = z.object({
  status: z.enum(['aberto', 'fechado']).optional(),
  userId: z.string().uuid().optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  ...pagination,
});
export type CashSessionListQuery = z.infer<typeof cashSessionListQuerySchema>;

export const paginationQuerySchema = z.object({ ...pagination });
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

// ---------- Recebimento de fiado ----------
export const debtReceiptSchema = z.object({
  idempotencyKey,
  payments: z.array(paymentInputSchema).min(1).max(10),
  note: optionalText(300),
});
export type DebtReceiptInput = z.infer<typeof debtReceiptSchema>;

export const debtReceiptReverseSchema = z.object({
  idempotencyKey,
  reason: z.string().trim().min(3).max(300),
});
export type DebtReceiptReverseInput = z.infer<typeof debtReceiptReverseSchema>;

export const saleDueDateSchema = z.object({ dueDate: dateOnly.nullable() });
export type SaleDueDateInput = z.infer<typeof saleDueDateSchema>;

export const debtListQuerySchema = z.object({
  customerId: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
  overdue: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  ...pagination,
});
export type DebtListQuery = z.infer<typeof debtListQuerySchema>;

// ---------- DTOs: caixa e fiado ----------
export interface CashSessionDTO {
  id: string;
  number: number;
  status: 'aberto' | 'fechado';
  openedById: string;
  openedByName: string;
  openedAt: string;
  openingCents: number;
  closedByName: string | null;
  closedAt: string | null;
  countedCents: number | null;
  expectedCents: number | null;
  differenceCents: number | null;
  closeNote: string | null;
}

export interface MethodAmountDTO {
  method: PaymentMethod;
  receivedCents: number;
  refundedCents: number;
  netCents: number;
}

export interface CashReportDTO {
  openingCents: number;
  /** Faturamento: vendas criadas neste caixa (competência), independente de terem sido pagas. */
  salesCount: number;
  salesTotalCents: number;
  /** Cancelamentos e devoluções efetuados neste caixa. */
  cancelledCount: number;
  cancelledCents: number;
  returnsCount: number;
  returnsCents: number;
  /** Recebimento: dinheiro/PIX/cartão que de fato entrou (vendas + fiado), por modalidade. */
  byMethod: MethodAmountDTO[];
  receivedSalesCents: number;
  receivedDebtCents: number;
  refundedCents: number;
  receivedNetCents: number;
  suprimentoCents: number;
  sangriaCents: number;
  despesaCents: number;
  /** Estornos de movimentos (sinal já aplicado em `movementsNetCents`). */
  movementReversalsCents: number;
  movementsNetCents: number;
  /** Dinheiro esperado na gaveta: abertura + dinheiro líquido + movimentos. */
  expectedCashCents: number;
}

export type LedgerEntryType =
  | 'abertura'
  | 'recebimento_venda'
  | 'recebimento_fiado'
  | 'estorno_pagamento'
  | 'estorno_recebimento'
  | 'sangria'
  | 'suprimento'
  | 'despesa'
  | 'estorno_movimento';

export interface LedgerEntryDTO {
  id: string;
  type: LedgerEntryType;
  at: string;
  amountCents: number;
  method: PaymentMethod | null;
  /** Efeito na gaveta de dinheiro: entrada, saída ou nenhum (PIX/cartão). */
  cashEffect: 'entrada' | 'saida' | 'nenhum';
  operatorName: string | null;
  description: string | null;
  saleId: string | null;
  saleNumber: number | null;
  receiptId: string | null;
  customerName: string | null;
  /** Já possui estorno (movimentos) — não pode ser estornado de novo. */
  reversed: boolean;
}

export interface DebtReceiptDTO {
  id: string;
  number: number;
  kind: 'recebimento' | 'estorno';
  customerId: string;
  totalCents: number;
  createdAt: string;
  createdByName: string;
  note: string | null;
  reason: string | null;
  reversesReceiptId: string | null;
  reversed: boolean;
  allocations: { saleId: string; saleNumber: number; method: PaymentMethod; amountCents: number }[];
}

export interface OpenDebtDTO {
  saleId: string;
  saleNumber: number;
  createdAt: string;
  customerId: string;
  customerName: string;
  dueDate: string | null;
  overdue: boolean;
  totalCents: number;
  receivedCents: number;
  returnedCents: number;
  balanceCents: number;
}

export interface CustomerPaymentDTO {
  id: string;
  kind: 'recebimento' | 'estorno';
  method: PaymentMethod;
  amountCents: number;
  createdAt: string;
  saleId: string;
  saleNumber: number;
  receiptId: string | null;
  receiptNumber: number | null;
  /** 'venda' = pago no ato; 'posterior' = recebimento de fiado; 'estorno'. */
  origin: 'venda' | 'posterior' | 'estorno';
  operatorName: string | null;
}

export interface CustomerAccountDTO {
  customer: CustomerDTO;
  openDebts: OpenDebtDTO[];
  overdueCents: number;
  receipts: DebtReceiptDTO[];
}
