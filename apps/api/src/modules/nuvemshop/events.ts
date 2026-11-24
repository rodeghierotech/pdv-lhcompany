import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { many, maybeOne, withTransaction } from '../../db/pool.js';
import { recordAudit } from '../audit/service.js';
import {
  MAX_ATTEMPTS,
  PROVIDER,
  activeApi,
  backoffMs,
  handleAuthFailure,
  markConnection,
  nowOf,
} from './deps.js';
import type { NuvemshopDeps } from './deps.js';
import { applyOrderSnapshot } from './orders.js';
import { NuvemshopError } from './types.js';

/** Eventos que o PDV registra no webhook (POST /webhooks). */
export const SUBSCRIBED_EVENTS = [
  'order/created',
  'order/updated',
  'order/paid',
  'order/cancelled',
  'order/pending',
  'order/edited',
  'order/voided',
  'product/updated',
  'product/deleted',
] as const;

/** Verificação do cabeçalho `x-linkedstore-hmac-sha256` = HMAC-SHA256(secret do app, corpo cru), hex. */
export function verifyWebhookSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = Buffer.from(header.trim().toLowerCase(), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}

export interface WebhookPayload {
  store_id: number | string;
  event: string;
  id?: number | string;
  [k: string]: unknown;
}

export type IngestResult = 'registrado' | 'duplicado' | 'loja_desconhecida';

/**
 * Registra o webhook e responde rápido (a Nuvemshop espera 2xx em 3 s). Reentregas idênticas
 * de um evento AINDA NÃO INICIADO (pendente) viram uma só linha (índice único parcial); uma que chega
 * durante o processamento gera nova leitura do pedido.
 */
export async function ingestWebhook(
  deps: NuvemshopDeps,
  rawBody: string,
  payload: WebhookPayload,
  source: 'webhook' | 'reconcile' | 'manual' = 'webhook',
): Promise<IngestResult> {
  const storeId = String(payload.store_id);
  const conn = await maybeOne<{ external_store_id: string }>(
    deps.pool,
    'select external_store_id from integration_connections where provider = $1',
    [PROVIDER],
  );
  if (!conn || conn.external_store_id !== storeId) return 'loja_desconhecida';
  const dedupeKey = createHash('sha256').update(rawBody).digest('hex');
  const res = await deps.pool.query(
    `insert into integration_events (provider, source, external_store_id, event, entity_id, dedupe_key, payload)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (dedupe_key) where status = 'pendente' do nothing`,
    [
      PROVIDER,
      source,
      storeId,
      payload.event,
      payload.id !== undefined ? String(payload.id) : null,
      dedupeKey,
      JSON.stringify(payload),
    ],
  );
  await deps.pool.query(
    'update integration_connections set last_event_at = now() where provider = $1',
    [PROVIDER],
  );
  return res.rowCount ? 'registrado' : 'duplicado';
}

interface EventRow {
  id: string;
  event: string;
  entity_id: string | null;
  attempts: number;
}

export interface ProcessStats {
  processed: number;
  failed: number;
  ignored: number;
  skipped?: string;
}

async function finish(
  deps: NuvemshopDeps,
  id: string,
  status: 'processado' | 'ignorado',
  note: string | null = null,
) {
  await deps.pool.query(
    'update integration_events set status = $2, processed_at = now(), last_error = $3 where id = $1',
    [id, status, note],
  );
}

async function handleEvent(
  deps: NuvemshopDeps,
  ev: EventRow,
  ctx: NonNullable<Awaited<ReturnType<typeof activeApi>>>,
): Promise<'processado' | 'ignorado'> {
  const { event } = ev;
  if (event.startsWith('order/')) {
    if (!ev.entity_id) return 'ignorado';
    const order = await ctx.api.getOrder(ev.entity_id); // estado atual, não o do evento
    if (!order) return 'ignorado';
    await withTransaction(deps.pool, (tx) => applyOrderSnapshot(tx, ctx.conn, order));
    return 'processado';
  }
  if (event === 'product/deleted' && ev.entity_id) {
    await deps.pool.query(
      `update external_variant_links set status = 'removido_remoto', updated_at = now()
       where provider = $1 and external_product_id = $2 and status = 'ativo'`,
      [PROVIDER, ev.entity_id],
    );
    return 'processado';
  }
  if (event.startsWith('product/') && ev.entity_id) {
    // O estoque/preço remoto muda; a reconciliação (comparação com o local) trata a divergência.
    await deps.pool.query(
      `update external_variant_links set remote_seen_at = null, updated_at = now()
       where provider = $1 and external_product_id = $2 and status = 'ativo'`,
      [PROVIDER, ev.entity_id],
    );
    return 'processado';
  }
  return 'ignorado';
}

/** Eventos de ciclo de vida/LGPD chegam por webhook sem passar pela API da loja. */
export async function handleLifecycleEvent(
  deps: NuvemshopDeps,
  payload: WebhookPayload,
): Promise<boolean> {
  const ev = payload.event;
  if (ev === 'app/uninstalled' || ev === 'store/redact') {
    // Acesso revogado: apaga a credencial; o histórico financeiro/de estoque permanece.
    await deps.pool.query(
      `update integration_connections set status = 'revogada', access_token_enc = null, revoked_at = now(),
              last_error = $2, updated_at = now() where provider = $1`,
      [
        PROVIDER,
        ev === 'app/uninstalled' ? 'aplicativo desinstalado na loja' : 'store/redact recebido',
      ],
    );
    return true;
  }
  // Não armazenamos dados pessoais de compradores: nada a apagar/exportar localmente.
  return ev === 'customers/redact' || ev === 'customers/data_request';
}

/** Processa eventos pendentes (worker). Falhas temporárias reagendam com backoff. */
export async function processEvents(deps: NuvemshopDeps, limit = 20): Promise<ProcessStats> {
  const stats: ProcessStats = { processed: 0, failed: 0, ignored: 0 };
  const ctx = await activeApi(deps);
  if (!ctx) return { ...stats, skipped: 'sem_conexao_ativa' };

  const claimed = await withTransaction(deps.pool, async (tx) =>
    many<EventRow>(
      tx,
      `update integration_events set status = 'processando', attempts = attempts + 1
       where id in (select id from integration_events
                    where status in ('pendente', 'falha') and next_attempt_at <= coalesce($1::timestamptz, now()) and attempts < $2
                    order by received_at limit $3 for update skip locked)
       returning id, event, entity_id, attempts`,
      [deps.now ? deps.now() : null, MAX_ATTEMPTS, limit],
    ),
  );

  for (const ev of claimed) {
    try {
      const res = await handleEvent(deps, ev, ctx);
      await finish(deps, ev.id, res);
      if (res === 'ignorado') stats.ignored++;
      else stats.processed++;
    } catch (err) {
      stats.failed++;
      const message = err instanceof Error ? err.message : String(err);
      if (await handleAuthFailure(deps, err)) {
        await deps.pool.query(
          `update integration_events set status = 'falha', last_error = $2, next_attempt_at = $3, attempts = attempts - 1 where id = $1`,
          [ev.id, message, new Date(nowOf(deps).getTime() + 15 * 60_000)],
        );
        break; // sem autorização: para o ciclo
      }
      const wait =
        err instanceof NuvemshopError && err.kind === 'rate_limit'
          ? (err.retryAfterMs ?? 2000)
          : backoffMs(ev.attempts, deps.random);
      const permanent = err instanceof NuvemshopError && err.kind === 'permanent';
      await deps.pool.query(
        `update integration_events set status = 'falha', last_error = $2, next_attempt_at = $3, attempts = $4 where id = $1`,
        [
          ev.id,
          message,
          new Date(nowOf(deps).getTime() + wait),
          permanent ? MAX_ATTEMPTS : ev.attempts,
        ],
      );
    }
  }
  return stats;
}

/** Reprocessamento manual de um evento em falha (autorizado). */
export async function retryEvent(
  deps: NuvemshopDeps,
  eventId: string,
  actorId: string,
): Promise<boolean> {
  const res = await deps.pool.query(
    `update integration_events set status = 'pendente', attempts = 0, next_attempt_at = now(), last_error = null
     where id = $1 and status in ('falha', 'ignorado') returning id`,
    [eventId],
  );
  if (res.rowCount) {
    await recordAudit(deps.pool, {
      actorId,
      action: 'integration.event_retry',
      entity: 'integration_event',
      entityId: eventId,
    });
  }
  return !!res.rowCount;
}

export { markConnection };
