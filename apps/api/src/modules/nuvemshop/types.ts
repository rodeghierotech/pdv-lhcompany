/** Contratos mínimos da Admin API da Nuvemshop (versão 2025-03) usados pelo PDV. */

export interface RemoteVariant {
  id: string;
  productId: string;
  sku: string | null;
  barcode: string | null;
  priceCents: number | null;
  /** null = estoque ilimitado / não gerenciado. */
  stock: number | null;
  /** Locations com nível de estoque (se a loja usa múltiplas locations). */
  locationCount: number;
}

export interface RemoteProduct {
  id: string;
  name: string;
  variants: RemoteVariant[];
}

export interface RemoteOrderItem {
  productId: string;
  variantId: string;
  sku: string | null;
  quantity: number;
}

export interface RemoteOrder {
  id: string;
  number: string | null;
  status: 'open' | 'closed' | 'cancelled';
  paymentStatus: string;
  totalCents: number | null;
  paidAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  updatedAt: string | null;
  items: RemoteOrderItem[];
}

export interface RemoteLocation {
  id: string;
  name: string;
}

export interface RemoteWebhook {
  id: string;
  event: string;
  url: string;
}

/** Porta do adaptador: o restante do módulo só conhece esta interface. */
export interface NuvemshopApi {
  getOrder(orderId: string): Promise<RemoteOrder | null>;
  /** Pedidos atualizados desde `since` (varredura de eventos perdidos). */
  listOrdersUpdatedSince(
    since: Date,
    page: number,
  ): Promise<{ items: RemoteOrder[]; hasMore: boolean }>;
  listProducts(page: number): Promise<{ items: RemoteProduct[]; hasMore: boolean }>;
  getVariant(productId: string, variantId: string): Promise<RemoteVariant | null>;
  /** POST /products/{id}/variants/stock { action: 'variation', value, id } — delta atômico. */
  /** Devolve o estoque resultante informado pela resposta (null se a resposta não o trouxer). */
  adjustStock(productId: string, variantId: string, delta: number): Promise<number | null>;
  /** POST /products/{id}/variants/stock { action: 'replace', value, id } — só por decisão humana. */
  replaceStock(productId: string, variantId: string, value: number): Promise<void>;
  listLocations(): Promise<RemoteLocation[]>;
  listWebhooks(): Promise<RemoteWebhook[]>;
  createWebhook(event: string, url: string): Promise<RemoteWebhook>;
}

export type FailureKind = 'auth' | 'rate_limit' | 'transient' | 'permanent' | 'not_found';

export class NuvemshopError extends Error {
  constructor(
    public readonly kind: FailureKind,
    message: string,
    public readonly status?: number,
    /** Espera sugerida (ms) — ex.: cabeçalho x-rate-limit-reset em 429. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'NuvemshopError';
  }
}
