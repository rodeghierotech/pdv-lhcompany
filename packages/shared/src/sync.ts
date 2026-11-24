import { z } from 'zod';
import { saleCreateSchema } from './schemas.js';

/** Estados de sincronização exibidos ao operador. */
export const SYNC_STATES = [
  'local',
  'pendente',
  'confirmada',
  'falha_recuperavel',
  'conflito',
] as const;
export type SyncState = (typeof SYNC_STATES)[number];

/** Validade máxima da autorização offline (8 h). */
export const OFFLINE_GRANT_MAX_AGE_MS = 8 * 60 * 60 * 1000;

export const offlineGrantRequestSchema = z.object({ deviceId: z.string().uuid() });

export interface OfflineGrantClaims {
  v: 1;
  /** usuário */
  sub: string;
  role: 'admin' | 'gerente' | 'vendedor';
  /** dispositivo */
  did: string;
  /** emitida / expira (epoch ms) */
  iat: number;
  exp: number;
  jti: string;
}

export const offlineSalePayloadSchema = saleCreateSchema.omit({ idempotencyKey: true });
export type OfflineSalePayload = z.infer<typeof offlineSalePayloadSchema>;

export const syncOperationSchema = z.object({
  operationId: z.string().uuid(),
  sequence: z.number().int().min(0),
  type: z.literal('create_sale'),
  createdAt: z.string().datetime({ offset: true }),
  /** Caixa em que a venda foi realizada (conhecido pelo aparelho enquanto estava online). */
  cashSessionId: z.string().uuid(),
  dependsOn: z.array(z.string().uuid()).max(50).default([]),
  reversesOperationId: z.string().uuid().optional(),
  payload: offlineSalePayloadSchema,
});
export type SyncOperationInput = z.infer<typeof syncOperationSchema>;

export const syncRequestSchema = z.object({
  deviceId: z.string().uuid(),
  grant: z.string().min(20).max(2000),
  operations: z.array(syncOperationSchema).min(1).max(50),
});
export type SyncRequest = z.infer<typeof syncRequestSchema>;

export interface SyncConflictDTO {
  code: string;
  blocking: boolean;
  message: string;
  details: Record<string, unknown>;
}

export interface SyncResultDTO {
  operationId: string;
  status: 'confirmada' | 'falha_recuperavel' | 'conflito';
  saleId?: string;
  saleNumber?: number;
  /** true quando o servidor já havia processado esta operação (reenvio). */
  duplicate?: boolean;
  resolution?: 'aprovada' | 'descartada';
  error?: { code: string; message: string };
  conflicts?: SyncConflictDTO[];
}

export const syncResolveSchema = z.object({
  action: z.enum(['aprovar', 'descartar']),
  note: z.string().trim().min(3).max(300),
});
export type SyncResolveInput = z.infer<typeof syncResolveSchema>;

export interface CatalogVariantDTO {
  id: string;
  sku: string;
  barcode: string | null;
  productName: string;
  size: string | null;
  color: string | null;
  priceCents: number;
  stock: number;
}
export interface CatalogCustomerDTO {
  id: string;
  name: string;
  document: string | null;
  phone: string | null;
  creditLimitCents: number | null;
}
export interface CatalogSnapshotDTO {
  generatedAt: string;
  variants: CatalogVariantDTO[];
  customers: CatalogCustomerDTO[];
  discountLimitBp: number;
}
