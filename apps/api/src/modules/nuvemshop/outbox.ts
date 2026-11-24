import { randomUUID } from 'node:crypto';
import { many, maybeOne, withTransaction } from '../../db/pool.js';
import { recordAudit } from '../audit/service.js';
import {
  MAX_ATTEMPTS,
  PROVIDER,
  activeApi,
  backoffMs,
  handleAuthFailure,
  isMultiLocation,
  nowOf,
  openIssue,
} from './deps.js';
import type { ApiCtx, NuvemshopDeps } from './deps.js';
import { NuvemshopError } from './types.js';
import type { RemoteVariant } from './types.js';

interface LinkRow {
  id: string;
  external_product_id: string;
  external_variant_id: string;
  remote_stock_ack: number | null;
}
interface OutboxRow {
  id: string;
  delta: number;
  attempts: number;
  batch_id: string | null;
  batch_base: number | null;
  batch_delta: number | null;
}

export interface OutboxStats {
  sent: number;
  failed: number;
  conflicts: number;
  skipped?: string;
}

const LEASE_MS = 5 * 60_000;

/**
 * Envia os movimentos de estoque local para a Nuvemshop, agregando por variante em UM delta
 * (`action: variation`). Nunca grava valor absoluto: alterações legítimas feitas na loja são
 * preservadas.
 *
 * Segurança contra baixa duplicada (o endpoint `variation` NÃO é idempotente):
 *  1. Antes da chamada, grava no lote (`batch_id/base/delta`) o estoque remoto lido e o delta.
 *  2. Se a resposta se perder (timeout/5xx), o lote fica "em dúvida" e NENHUMA linha nova entra
 *     nele. No retry, relê o remoto: == max(0, base+delta) → já aplicado (confirma sem reenviar);
 *     == base → não aplicado (reenvia o MESMO delta); outro valor → ambíguo: conflito + pendência
 *     `envio_incerto` para decisão humana (nunca reenvia às cegas).
 *  3. Erros em que a requisição foi comprovadamente recusada (401/403/404/422/429) limpam o lote.
 */
async function settle(
  deps: NuvemshopDeps,
  ids: string[],
  status: 'enviado' | 'conflito' | 'cancelado',
  note: string | null,
) {
  await deps.pool.query(
    `update integration_outbox
        set status = $2, note = $3, last_error = null, sent_at = case when $2 = 'enviado' then now() end
      where id = any($1)`,
    [ids, status, note],
  );
}

async function confirmed(
  deps: NuvemshopDeps,
  linkId: string,
  ids: string[],
  note: string | null,
  remoteStock: number,
) {
  await withTransaction(deps.pool, async (tx) => {
    await tx.query(
      `update integration_outbox set status = 'enviado', sent_at = now(), note = $2, last_error = null where id = any($1)`,
      [ids, note],
    );
    await tx.query(
      `update external_variant_links
          set remote_stock_ack = $2, remote_stock_seen = $2, remote_seen_at = now(), divergence_streak = 0, updated_at = now()
        where id = $1`,
      [linkId, remoteStock],
    );
    await tx.query(
      'update integration_connections set last_outbox_ok_at = now(), last_error = null where provider = $1',
      [PROVIDER],
    );
  });
}

/** Valida a variante remota; devolve true se o envio pode seguir. */
async function checkRemote(
  deps: NuvemshopDeps,
  ctx: ApiCtx,
  link: LinkRow,
  remote: RemoteVariant | null,
  ids: string[],
  stats: OutboxStats,
): Promise<boolean> {
  if (!remote) {
    await deps.pool.query(
      "update external_variant_links set status = 'removido_remoto', updated_at = now() where id = $1",
      [link.id],
    );
    await settle(deps, ids, 'conflito', 'variante removida na Nuvemshop');
    stats.conflicts += ids.length;
    return false;
  }
  if (await isMultiLocation(ctx, remote.locationCount)) {
    await openIssue(deps.pool, {
      kind: 'multiplas_locations',
      dedupeKey: `multiloc:${link.id}`,
      title: 'Loja com múltiplas locations de estoque: envio automático não suportado nesta versão',
      details: {
        productId: link.external_product_id,
        variantId: link.external_variant_id,
        locations: remote.locationCount,
      },
      linkId: link.id,
    });
    await settle(deps, ids, 'conflito', 'múltiplas locations: exige decisão manual');
    stats.conflicts += ids.length;
    return false;
  }
  if (remote.stock === null) {
    await settle(deps, ids, 'cancelado', 'estoque não gerenciado na Nuvemshop (ilimitado)');
    return false;
  }
  return true;
}

const expectedAfter = (base: number, delta: number) => Math.max(0, base + delta);

async function shortageIssue(
  deps: NuvemshopDeps,
  link: LinkRow,
  firstId: string,
  base: number,
  delta: number,
) {
  if (base + delta >= 0) return;
  await openIssue(deps.pool, {
    kind: 'estoque_remoto_insuficiente',
    dedupeKey: `remote-short:${link.id}:${firstId}`,
    title: 'Estoque da Nuvemshop era menor que a baixa local; ficou em 0',
    details: { remote: base, delta },
    linkId: link.id,
  });
}

/** Marca falha do envio. `applied` desconhecido (transiente) mantém o lote; recusa comprovada o limpa. */
async function failRows(deps: NuvemshopDeps, ids: string[], attempts: number, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const refused =
    err instanceof NuvemshopError &&
    (err.kind === 'auth' ||
      err.kind === 'rate_limit' ||
      err.kind === 'permanent' ||
      err.kind === 'not_found');
  let status = 'pendente';
  let wait = backoffMs(attempts, deps.random);
  let burn = true;
  if (await handleAuthFailure(deps, err)) {
    wait = 15 * 60_000;
    burn = false;
  } else if (err instanceof NuvemshopError && err.kind === 'rate_limit') {
    wait = err.retryAfterMs ?? 2000;
    burn = false;
  } else if (err instanceof NuvemshopError && err.kind === 'permanent') {
    status = 'falha';
  } else if (attempts >= MAX_ATTEMPTS) {
    status = 'falha';
  }
  await deps.pool.query(
    `update integration_outbox
        set status = $2, last_error = $3, next_attempt_at = $4,
            attempts = case when $5 then attempts else greatest(attempts - 1, 0) end,
            batch_id = case when $6 then null else batch_id end,
            batch_base = case when $6 then null else batch_base end,
            batch_delta = case when $6 then null else batch_delta end
      where id = any($1)`,
    [ids, status, message, new Date(nowOf(deps).getTime() + wait), burn, refused],
  );
}

async function sendForLink(
  deps: NuvemshopDeps,
  ctx: ApiCtx,
  linkId: string,
  stats: OutboxStats,
): Promise<void> {
  const now = nowOf(deps);
  const link = await maybeOne<LinkRow>(
    deps.pool,
    `update external_variant_links set sending_since = $2
      where id = $1 and status = 'ativo' and (sending_since is null or sending_since < $3)
      returning id, external_product_id, external_variant_id, remote_stock_ack`,
    [linkId, now, new Date(now.getTime() - LEASE_MS)],
  );
  if (!link) return; // outro worker está enviando esta variante

  let inFlight: OutboxRow[] = [];
  try {
    for (let round = 0; round < 2; round++) {
      // 1) Lote em dúvida (tentativa anterior sem resposta confirmada)?
      const doubtful = await many<OutboxRow>(
        deps.pool,
        `select id, delta, attempts, batch_id, batch_base, batch_delta from integration_outbox
          where link_id = $1 and status = 'pendente' and batch_id is not null order by created_at`,
        [linkId],
      );
      if (doubtful.length > 0) {
        const due = await maybeOne(
          deps.pool,
          `select 1 from integration_outbox where link_id = $1 and status = 'pendente' and batch_id is not null
              and next_attempt_at <= coalesce($2::timestamptz, now()) limit 1`,
          [linkId, deps.now ? deps.now() : null],
        );
        if (!due) return; // ainda em espera: linhas novas aguardam o lote em dúvida
        const rows = await many<OutboxRow>(
          deps.pool,
          `update integration_outbox set status = 'enviando', attempts = attempts + 1
            where id = any($1) returning id, delta, attempts, batch_id, batch_base, batch_delta`,
          [doubtful.map((r) => r.id)],
        );
        inFlight = rows;
        const ids = rows.map((r) => r.id);
        const base = rows[0]!.batch_base!;
        const delta = rows[0]!.batch_delta!;
        const remote = await ctx.api.getVariant(link.external_product_id, link.external_variant_id);
        if (!(await checkRemote(deps, ctx, link, remote, ids, stats))) return;
        const stock = remote!.stock!;
        if (stock === expectedAfter(base, delta)) {
          await confirmed(
            deps,
            linkId,
            ids,
            'já aplicado (confirmado por leitura após resposta perdida)',
            stock,
          );
          stats.sent += rows.length;
          inFlight = [];
          continue;
        }
        if (stock === base) {
          const after = await ctx.api.adjustStock(
            link.external_product_id,
            link.external_variant_id,
            delta,
          );
          await shortageIssue(deps, link, ids[0]!, base, delta);
          await confirmed(
            deps,
            linkId,
            ids,
            'reenviado (a tentativa anterior não havia sido aplicada)',
            after ?? expectedAfter(base, delta),
          );
          stats.sent += rows.length;
          inFlight = [];
          continue;
        }
        await settle(
          deps,
          ids,
          'conflito',
          `resultado incerto: remoto ${stock}, esperado ${base} ou ${expectedAfter(base, delta)}`,
        );
        await openIssue(deps.pool, {
          kind: 'envio_incerto',
          dedupeKey: `uncertain:${linkId}:${rows[0]!.batch_id}`,
          title:
            'Envio de estoque com resultado incerto (a loja mudou durante a falha): decisão manual',
          details: { base, delta, remote: stock },
          linkId,
        });
        stats.conflicts += rows.length;
        inFlight = [];
        return;
      }

      // 2) Novo lote com as linhas pendentes (sem lote).
      const nowDb = deps.now ? deps.now() : null;
      const fresh = await many<{ id: string; delta: number; attempts: number }>(
        deps.pool,
        `select id, delta, attempts from integration_outbox
          where link_id = $1 and status = 'pendente' and batch_id is null
            and next_attempt_at <= coalesce($2::timestamptz, now()) order by created_at`,
        [linkId, nowDb],
      );
      if (fresh.length === 0) return;
      const remote = await ctx.api.getVariant(link.external_product_id, link.external_variant_id);
      const ids = fresh.map((r) => r.id);
      if (!(await checkRemote(deps, ctx, link, remote, ids, stats))) return;
      const base = remote!.stock!;
      const delta = fresh.reduce((n, r) => n + r.delta, 0);
      const batchId = randomUUID();
      const claimed = await many<OutboxRow>(
        deps.pool,
        `update integration_outbox
            set status = 'enviando', attempts = attempts + 1, batch_id = $2, batch_base = $3, batch_delta = $4
          where id = any($1) and status = 'pendente' and batch_id is null
          returning id, delta, attempts, batch_id, batch_base, batch_delta`,
        [ids, batchId, base, delta],
      );
      inFlight = claimed;
      let note: string | null = null;
      if (link.remote_stock_ack !== null && base !== link.remote_stock_ack) {
        note = `estoque remoto havia mudado (${link.remote_stock_ack} → ${base}); delta aplicado sobre o valor atual, sem sobrescrever`;
      }
      const after = await ctx.api.adjustStock(
        link.external_product_id,
        link.external_variant_id,
        delta,
      );
      await shortageIssue(deps, link, ids[0]!, base, delta);
      await confirmed(deps, linkId, ids, note, after ?? expectedAfter(base, delta));
      stats.sent += claimed.length;
      inFlight = [];
      return;
    }
  } catch (err) {
    if (inFlight.length > 0) {
      stats.failed += inFlight.length;
      await failRows(
        deps,
        inFlight.map((r) => r.id),
        Math.max(...inFlight.map((r) => r.attempts)),
        err,
      );
    } else {
      // falha ao ler o remoto antes de qualquer tentativa: nada foi enviado
      stats.failed += 1;
      await handleAuthFailure(deps, err);
      const wait =
        err instanceof NuvemshopError && err.retryAfterMs
          ? err.retryAfterMs
          : backoffMs(1, deps.random);
      await deps.pool.query(
        `update integration_outbox set next_attempt_at = $2, last_error = $3 where link_id = $1 and status = 'pendente'`,
        [
          linkId,
          new Date(nowOf(deps).getTime() + wait),
          err instanceof Error ? err.message : String(err),
        ],
      );
    }
  } finally {
    await deps.pool.query('update external_variant_links set sending_since = null where id = $1', [
      linkId,
    ]);
  }
}

export async function sendOutbox(deps: NuvemshopDeps, maxLinks = 50): Promise<OutboxStats> {
  const stats: OutboxStats = { sent: 0, failed: 0, conflicts: 0 };
  const ctx = await activeApi(deps);
  if (!ctx) return { ...stats, skipped: 'sem_conexao_ativa' };
  // Linhas "enviando" órfãs (worker morreu) voltam à fila quando a lease expira; o lote em dúvida
  // (batch_id) é preservado e resolvido por leitura, nunca reenviado às cegas.
  await deps.pool.query(
    `update integration_outbox o set status = 'pendente'
       from external_variant_links l
      where o.link_id = l.id and o.status = 'enviando' and (l.sending_since is null or l.sending_since < $1)`,
    [new Date(nowOf(deps).getTime() - LEASE_MS)],
  );
  const links = await many<{ link_id: string }>(
    deps.pool,
    `select distinct link_id from integration_outbox
      where status = 'pendente' and next_attempt_at <= coalesce($1::timestamptz, now()) limit $2`,
    [deps.now ? deps.now() : null, maxLinks],
  );
  for (const { link_id } of links) {
    await sendForLink(deps, ctx, link_id, stats);
    if (stats.failed > 0 && (await activeApi(deps)) === null) break; // autorização perdida
  }
  return stats;
}

/** Reprocessamento manual de itens em falha/conflito (autorizado e auditado). O lote em dúvida é mantido. */
export async function retryOutbox(
  deps: NuvemshopDeps,
  outboxId: string,
  actorId: string,
): Promise<boolean> {
  const res = await deps.pool.query(
    `update integration_outbox set status = 'pendente', attempts = 0, next_attempt_at = now(), last_error = null
      where id = $1 and status in ('falha', 'conflito') returning id`,
    [outboxId],
  );
  if (res.rowCount) {
    await recordAudit(deps.pool, {
      actorId,
      action: 'integration.outbox_retry',
      entity: 'integration_outbox',
      entityId: outboxId,
    });
  }
  return !!res.rowCount;
}
