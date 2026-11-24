import { NuvemshopError } from './types.js';
import type {
  NuvemshopApi,
  RemoteLocation,
  RemoteOrder,
  RemoteProduct,
  RemoteVariant,
  RemoteWebhook,
} from './types.js';

export interface ClientOptions {
  /** Ex.: https://api.nuvemshop.com.br/2025-03 */
  apiBase: string;
  storeId: string;
  accessToken: string;
  userAgent: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Notificado com os cabeçalhos x-rate-limit-* de cada resposta. */
  onRateLimit?: (info: { remaining: number | null; resetMs: number | null }) => void;
}

const PER_PAGE = 200;
const toCents = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
/** Valor localizado ({ pt: '...', es: '...' }) ou texto simples. */
const localized = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return String(o.pt ?? o.pt_BR ?? o.es ?? o.en ?? Object.values(o)[0] ?? '');
  }
  return '';
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapVariant(productId: string, v: any): RemoteVariant {
  const levels: any[] = Array.isArray(v.inventory_levels) ? v.inventory_levels : [];
  // `stock` é o total entre locations; null quando o estoque não é gerenciado.
  const stock =
    v.stock === null || v.stock === undefined || v.stock === '' ? null : Number(v.stock);
  return {
    id: String(v.id),
    productId: String(v.product_id ?? productId),
    sku: str(v.sku),
    barcode: str(v.barcode),
    priceCents: toCents(v.price),
    stock: Number.isFinite(stock as number) ? stock : null,
    locationCount: levels.length,
  };
}

export function mapOrder(o: any): RemoteOrder {
  return {
    id: String(o.id),
    number: str(o.number),
    status: o.status === 'cancelled' || o.status === 'closed' ? o.status : 'open',
    paymentStatus: String(o.payment_status ?? 'pending'),
    totalCents: toCents(o.total),
    paidAt: str(o.paid_at),
    cancelledAt: str(o.cancelled_at),
    cancelReason: str(o.cancel_reason),
    updatedAt: str(o.updated_at),
    items: (Array.isArray(o.products) ? o.products : []).map((p: any) => ({
      productId: str(p.product_id) ?? '',
      variantId: str(p.variant_id) ?? '',
      sku: str(p.sku),
      quantity: Number(p.quantity),
    })),
  };
}

/** Adaptador HTTP da Admin API (Authorization: Bearer, User-Agent obrigatório, limites 429). */
export function createNuvemshopClient(opts: ClientOptions): NuvemshopApi {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = `${opts.apiBase.replace(/\/$/, '')}/${opts.storeId}`;

  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ json: any; link: string | null }> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${opts.accessToken}`,
          'User-Agent': opts.userAgent,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new NuvemshopError('transient', `falha de rede: ${(err as Error).message}`);
    }
    const remaining = Number(res.headers.get('x-rate-limit-remaining'));
    const reset = Number(res.headers.get('x-rate-limit-reset'));
    opts.onRateLimit?.({
      remaining:
        Number.isFinite(remaining) && res.headers.has('x-rate-limit-remaining') ? remaining : null,
      resetMs: Number.isFinite(reset) && res.headers.has('x-rate-limit-reset') ? reset : null,
    });
    if (res.status === 401 || res.status === 403) {
      throw new NuvemshopError('auth', `autorização recusada (${res.status})`, res.status);
    }
    if (res.status === 404) throw new NuvemshopError('not_found', 'não encontrado', 404);
    if (res.status === 429) {
      throw new NuvemshopError(
        'rate_limit',
        'limite de requisições excedido',
        429,
        Number.isFinite(reset) && reset > 0 ? reset : 2000,
      );
    }
    if (res.status >= 500)
      throw new NuvemshopError('transient', `erro do servidor (${res.status})`, res.status);
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).split(opts.accessToken).join('[redigido]');
      throw new NuvemshopError(
        'permanent',
        `requisição recusada (${res.status}): ${text.slice(0, 300)}`,
        res.status,
      );
    }
    const text = await res.text();
    return { json: text ? JSON.parse(text) : null, link: res.headers.get('link') };
  }

  const hasNext = (link: string | null, count: number) =>
    link ? /rel="next"/.test(link) : count >= PER_PAGE;

  return {
    async getOrder(orderId) {
      try {
        return mapOrder((await request('GET', `/orders/${encodeURIComponent(orderId)}`)).json);
      } catch (e) {
        if (e instanceof NuvemshopError && e.kind === 'not_found') return null;
        throw e;
      }
    },
    async listOrdersUpdatedSince(since, page) {
      const q = new URLSearchParams({
        updated_at_min: since.toISOString(),
        page: String(page),
        per_page: String(PER_PAGE),
        status: 'any',
      });
      const { json, link } = await request('GET', `/orders?${q}`);
      const items = (Array.isArray(json) ? json : []).map(mapOrder);
      return { items, hasMore: hasNext(link, items.length) };
    },
    async listProducts(page) {
      const q = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) });
      const { json, link } = await request('GET', `/products?${q}`);
      const raw: any[] = Array.isArray(json) ? json : [];
      const items: RemoteProduct[] = raw.map((p) => ({
        id: String(p.id),
        name: localized(p.name),
        variants: (Array.isArray(p.variants) ? p.variants : []).map((v: any) =>
          mapVariant(String(p.id), v),
        ),
      }));
      return { items, hasMore: hasNext(link, raw.length) };
    },
    async getVariant(productId, variantId) {
      try {
        const { json } = await request(
          'GET',
          `/products/${encodeURIComponent(productId)}/variants/${encodeURIComponent(variantId)}`,
        );
        return mapVariant(productId, json);
      } catch (e) {
        if (e instanceof NuvemshopError && e.kind === 'not_found') return null;
        throw e;
      }
    },
    async adjustStock(productId, variantId, delta) {
      // A API responde com a lista de variantes atualizadas (com o estoque resultante).
      const { json } = await request(
        'POST',
        `/products/${encodeURIComponent(productId)}/variants/stock`,
        { action: 'variation', value: delta, id: Number(variantId) },
      );
      const row = (Array.isArray(json) ? json : []).find(
        (v: any) => String(v?.id) === String(variantId),
      );
      return row ? mapVariant(productId, row).stock : null;
    },
    async replaceStock(productId, variantId, value) {
      await request('POST', `/products/${encodeURIComponent(productId)}/variants/stock`, {
        action: 'replace',
        value,
        id: Number(variantId),
      });
    },
    async listLocations() {
      const { json } = await request('GET', '/locations');
      return (Array.isArray(json) ? json : []).map((l: any): RemoteLocation => ({
        id: String(l.id),
        name: localized(l.name),
      }));
    },
    async listWebhooks() {
      const { json } = await request('GET', '/webhooks');
      return (Array.isArray(json) ? json : []).map((w: any): RemoteWebhook => ({
        id: String(w.id),
        event: String(w.event),
        url: String(w.url),
      }));
    },
    async createWebhook(event, url) {
      const { json } = await request('POST', '/webhooks', { event, url });
      return {
        id: String(json.id),
        event: String(json.event ?? event),
        url: String(json.url ?? url),
      };
    },
  };
}

/** Troca do `code` OAuth por token (POST https://www.tiendanube.com/apps/authorize/token). */
export async function exchangeAuthorizationCode(args: {
  authBase: string;
  appId: string;
  clientSecret: string;
  code: string;
  userAgent: string;
  fetchImpl?: typeof fetch;
}): Promise<{ accessToken: string; scope: string; storeId: string }> {
  const doFetch = args.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${args.authBase.replace(/\/$/, '')}/apps/authorize/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': args.userAgent },
      body: JSON.stringify({
        client_id: args.appId,
        client_secret: args.clientSecret,
        grant_type: 'authorization_code',
        code: args.code,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new NuvemshopError('transient', `falha de rede: ${(err as Error).message}`);
  }
  if (!res.ok)
    throw new NuvemshopError(
      res.status >= 500 ? 'transient' : 'auth',
      `troca do código recusada (${res.status})`,
      res.status,
    );
  const json: any = await res.json();
  if (!json?.access_token || !(json.user_id ?? json.store_id)) {
    throw new NuvemshopError('permanent', 'resposta do OAuth sem access_token/user_id');
  }
  return {
    accessToken: String(json.access_token),
    scope: String(json.scope ?? ''),
    storeId: String(json.user_id ?? json.store_id),
  };
}
