import { many, maybeOne, one, withTransaction } from '../../db/pool.js';
import type { Db } from '../../db/pool.js';
import { errors } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import {
  PROVIDER,
  activeApi,
  autoResolveIssues,
  getConnection,
  handleAuthFailure,
  isMultiLocation,
  nowOf,
  openIssue,
} from './deps.js';
import type { NuvemshopDeps } from './deps.js';
import { ingestWebhook } from './events.js';

export interface ReconcileStats {
  checked: number;
  diverged: number;
  opened: number;
  ordersQueued: number;
  skipped?: string;
}

interface LinkRow {
  id: string;
  local_variant_id: string;
  external_product_id: string;
  external_variant_id: string;
  remote_stock_seen: number | null;
}

const localStock = async (db: Parameters<typeof maybeOne>[0], variantId: string): Promise<number> =>
  (
    await maybeOne<{ q: number }>(
      db,
      'select coalesce(quantity, 0)::int as q from stock_levels where variant_id = $1',
      [variantId],
    )
  )?.q ?? 0;

/**
 * Compara estoque remoto x local. Só abre pendência após 2 observações consecutivas IGUAIS e
 * sem nada em trânsito (outbox pendente, pedido online ainda não baixado): a Nuvemshop pode já
 * ter reservado/baixado estoque de um pedido que o PDV ainda não processou.
 */
export async function reconcileStock(deps: NuvemshopDeps, limit = 100): Promise<ReconcileStats> {
  const stats: ReconcileStats = { checked: 0, diverged: 0, opened: 0, ordersQueued: 0 };
  const ctx = await activeApi(deps);
  if (!ctx) return { ...stats, skipped: 'sem_conexao_ativa' };
  const links = await many<LinkRow>(
    deps.pool,
    `select id, local_variant_id, external_product_id, external_variant_id, remote_stock_seen
     from external_variant_links where provider = $1 and status = 'ativo' order by coalesce(remote_seen_at, 'epoch') limit $2`,
    [PROVIDER, limit],
  );
  try {
    for (const l of links) {
      const remote = await ctx.api.getVariant(l.external_product_id, l.external_variant_id);
      if (!remote) {
        await deps.pool.query(
          "update external_variant_links set status = 'removido_remoto', updated_at = now() where id = $1",
          [l.id],
        );
        continue;
      }
      stats.checked++;
      if (remote.stock === null || (await isMultiLocation(ctx, remote.locationCount))) {
        await deps.pool.query(
          'update external_variant_links set remote_seen_at = now() where id = $1',
          [l.id],
        );
        continue;
      }
      const local = await localStock(deps.pool, l.local_variant_id);
      const inflight = await maybeOne(
        deps.pool,
        `select 1 from integration_outbox where link_id = $1 and status in ('pendente', 'enviando', 'falha')
         union all
         select 1 from online_order_items i join online_orders o on o.id = i.order_id
          where i.local_variant_id = $2 and i.stock_status = 'pendente' and o.status <> 'cancelled'
         union all
         select 1 from integration_events
          where status in ('pendente', 'processando', 'falha') and event like 'order/%' limit 1`,
        [l.id, l.local_variant_id],
      );
      const key = `diverge:${l.id}`;
      if (remote.stock === local) {
        await withTransaction(deps.pool, async (tx) => {
          await tx.query(
            'update external_variant_links set remote_stock_seen = $2, remote_seen_at = now(), divergence_streak = 0 where id = $1',
            [l.id, remote.stock],
          );
          await autoResolveIssues(tx, key, 'estoques voltaram a coincidir');
        });
        continue;
      }
      stats.diverged++;
      if (inflight) {
        await deps.pool.query(
          'update external_variant_links set remote_stock_seen = $2, remote_seen_at = now(), divergence_streak = 0 where id = $1',
          [l.id, remote.stock],
        );
        continue;
      }
      const stable = l.remote_stock_seen === remote.stock;
      const streak = await one<{ divergence_streak: number }>(
        deps.pool,
        `update external_variant_links set remote_stock_seen = $2, remote_seen_at = now(),
                divergence_streak = case when $3 then divergence_streak + 1 else 1 end
         where id = $1 returning divergence_streak`,
        [l.id, remote.stock, stable],
      );
      if (streak.divergence_streak >= 2) {
        await openIssue(deps.pool, {
          kind: 'estoque_divergente',
          dedupeKey: key,
          title: `Estoque diverge entre PDV (${local}) e Nuvemshop (${remote.stock})`,
          details: {
            local,
            remote: remote.stock,
            productId: l.external_product_id,
            variantId: l.external_variant_id,
          },
          linkId: l.id,
        });
        stats.opened++;
      }
    }
  } catch (err) {
    if (!(await handleAuthFailure(deps, err))) throw err;
    return { ...stats, skipped: 'autorizacao_invalida' };
  }
  await deps.pool.query(
    'update integration_connections set last_reconcile_at = now() where provider = $1',
    [PROVIDER],
  );
  return stats;
}

/** Varredura de pedidos atualizados (cobre webhooks perdidos); vira eventos de origem `reconcile`. */
export async function sweepOrders(deps: NuvemshopDeps): Promise<ReconcileStats> {
  const stats: ReconcileStats = { checked: 0, diverged: 0, opened: 0, ordersQueued: 0 };
  const ctx = await activeApi(deps);
  if (!ctx) return { ...stats, skipped: 'sem_conexao_ativa' };
  // Sem cursor: começa na conexão (não importa histórico anterior à integração).
  const since = new Date((ctx.conn.orders_cursor ?? ctx.conn.connected_at).getTime() - 60_000);
  let maxSeen = ctx.conn.orders_cursor ?? ctx.conn.connected_at;
  try {
    for (let page = 1; page <= 50; page++) {
      const { items, hasMore } = await ctx.api.listOrdersUpdatedSince(since, page);
      for (const o of items) {
        stats.checked++;
        const body = JSON.stringify({
          store_id: ctx.conn.external_store_id,
          event: 'order/updated',
          id: o.id,
          updated_at: o.updatedAt,
        });
        const res = await ingestWebhook(
          deps,
          body,
          { store_id: ctx.conn.external_store_id, event: 'order/updated', id: o.id },
          'reconcile',
        );
        if (res === 'registrado') stats.ordersQueued++;
        if (o.updatedAt && new Date(o.updatedAt) > maxSeen) maxSeen = new Date(o.updatedAt);
      }
      if (!hasMore) break;
    }
  } catch (err) {
    if (!(await handleAuthFailure(deps, err))) throw err;
    return { ...stats, skipped: 'autorizacao_invalida' };
  }
  await deps.pool.query(
    'update integration_connections set orders_cursor = $2 where provider = $1',
    [PROVIDER, maxSeen],
  );
  return stats;
}

export type IssueAction = 'aceitar_remoto' | 'enviar_local' | 'baixar_agora' | 'ignorar';

/**
 * Resolução humana de pendências.
 *  - Ações sobre estoque releem o remoto, exigem fila vazia para a variante (senão o delta pendente
 *    seria aplicado por cima do valor acertado) e rodam sob lock do vínculo e do saldo.
 *  - `sem_estoque`/`item_nao_mapeado`: `baixar_agora` recoloca os itens na fila e reprocessa o pedido
 *    (baixa 1× por item, idempotente); `ignorar` marca os itens como tratados (nunca baixados depois).
 */
export async function resolveIssue(
  deps: NuvemshopDeps,
  issueId: string,
  action: IssueAction,
  actorId: string,
  note?: string,
): Promise<void> {
  const issue = await maybeOne<{
    id: string;
    kind: string;
    status: string;
    link_id: string | null;
    online_order_id: string | null;
    details: { remote?: number };
  }>(
    deps.pool,
    'select id, kind, status, link_id, online_order_id, details from integration_issues where id = $1',
    [issueId],
  );
  if (!issue) throw errors.notFound('Pendência');
  if (issue.status !== 'aberto') {
    throw errors.conflict('ISSUE_ALREADY_RESOLVED', 'Pendência já resolvida');
  }
  const finish = async (db: Db, resolution: string) => {
    await db.query(
      `update integration_issues set status = 'resolvido', resolved_at = now(), resolved_by = $2, resolution = $3, resolution_note = $4 where id = $1`,
      [issueId, actorId, resolution, note ?? null],
    );
    await recordAudit(db, {
      actorId,
      action: `integration.issue_${resolution}`,
      entity: 'integration_issue',
      entityId: issueId,
    });
  };

  const orderKinds = ['sem_estoque', 'item_nao_mapeado'];
  if (action === 'baixar_agora') {
    if (!orderKinds.includes(issue.kind) || !issue.online_order_id) {
      throw errors.unprocessable(
        'ACTION_NOT_APPLICABLE',
        'Ação aplicável a pedido sem estoque/sem vínculo',
      );
    }
    const ord = await one<{ external_order_id: string }>(
      deps.pool,
      'select external_order_id from online_orders where id = $1',
      [issue.online_order_id],
    );
    await withTransaction(deps.pool, async (tx) => {
      await tx.query(
        `update online_order_items set stock_status = 'pendente' where order_id = $1 and stock_status in ('sem_estoque', 'nao_mapeado')`,
        [issue.online_order_id],
      );
      await finish(tx, 'baixar_agora');
    });
    const body = JSON.stringify({
      store_id: (await getConnection(deps.pool))?.external_store_id,
      event: 'order/updated',
      id: ord.external_order_id,
      manual: issueId,
    });
    await ingestWebhook(deps, body, JSON.parse(body), 'manual');
    return;
  }

  if (action === 'ignorar') {
    await withTransaction(deps.pool, async (tx) => {
      if (orderKinds.includes(issue.kind) && issue.online_order_id) {
        await tx.query(
          `update online_order_items set stock_status = 'nao_aplicavel' where order_id = $1 and stock_status in ('sem_estoque', 'nao_mapeado')`,
          [issue.online_order_id],
        );
      }
      await finish(tx, 'ignorar');
    });
    return;
  }

  // aceitar_remoto | enviar_local
  if (issue.kind !== 'estoque_divergente' && issue.kind !== 'envio_incerto') {
    throw errors.unprocessable(
      'ACTION_NOT_APPLICABLE',
      'Ação aplicável apenas a divergência de estoque',
    );
  }
  if (!issue.link_id) throw errors.unprocessable('ACTION_NOT_APPLICABLE', 'Pendência sem vínculo');
  const ctx = await activeApi(deps);
  if (!ctx) throw errors.conflict('INTEGRATION_NOT_ACTIVE', 'Integração sem conexão ativa');
  const link = await maybeOne<LinkRow>(
    deps.pool,
    `select id, local_variant_id, external_product_id, external_variant_id, remote_stock_seen
       from external_variant_links where id = $1 and status = 'ativo'`,
    [issue.link_id],
  );
  if (!link) throw errors.conflict('LINK_NOT_ACTIVE', 'Vínculo não está mais ativo');
  const remote = await ctx.api.getVariant(link.external_product_id, link.external_variant_id);
  if (!remote || remote.stock === null) {
    throw errors.conflict('REMOTE_UNAVAILABLE', 'Estoque remoto indisponível');
  }
  if (await isMultiLocation(ctx, remote.locationCount)) {
    throw errors.unprocessable(
      'MULTIPLE_LOCATIONS',
      'Múltiplas locations não são suportadas nesta versão',
    );
  }
  if (issue.details.remote !== undefined && issue.details.remote !== remote.stock) {
    throw errors.conflict('REMOTE_CHANGED', 'O estoque remoto mudou desde a pendência; reavalie');
  }
  const remoteStock = remote.stock;
  await withTransaction(deps.pool, async (tx) => {
    const lk = await maybeOne<{ sending_since: Date | null }>(
      tx,
      'select sending_since from external_variant_links where id = $1 for update',
      [link.id],
    );
    if (lk?.sending_since)
      throw errors.conflict('LINK_BUSY', 'Envio em andamento para esta variante; tente novamente');
    const pending = await maybeOne(
      tx,
      `select 1 from integration_outbox where link_id = $1 and status in ('pendente', 'enviando', 'falha') limit 1`,
      [link.id],
    );
    if (pending) {
      throw errors.conflict(
        'PENDING_OUTBOX',
        'Há envios de estoque pendentes para esta variante; aguarde ou reprocesse',
      );
    }
    // Bloqueia novos movimentos da variante enquanto decide e (se for o caso) envia.
    const local = await localStock(tx, link.local_variant_id);
    await tx.query('select 1 from stock_levels where variant_id = $1 for update', [
      link.local_variant_id,
    ]);
    if (action === 'aceitar_remoto') {
      const delta = remoteStock - local;
      if (delta !== 0) {
        // Chave `nuvemshop:` → o gatilho do outbox não devolve este ajuste ao canal.
        await tx.query(
          `insert into stock_movements (variant_id, type, quantity_delta, reason, idempotency_key, actor_id)
           values ($1, 'ajuste', $2, $3, $4, $5) on conflict (idempotency_key) do nothing`,
          [
            link.local_variant_id,
            delta,
            `Reconciliação Nuvemshop: aceito estoque remoto (${remoteStock})`,
            `nuvemshop:reconcile:${issueId}`,
            actorId,
          ],
        );
      }
    } else {
      // Valor absoluto por decisão humana, antes de gravar a resolução: se falhar, nada é resolvido.
      await ctx.api.replaceStock(link.external_product_id, link.external_variant_id, local);
    }
    const finalStock = action === 'aceitar_remoto' ? remoteStock : local;
    await tx.query(
      'update external_variant_links set remote_stock_ack = $2, remote_stock_seen = $2, divergence_streak = 0, remote_seen_at = now() where id = $1',
      [link.id, finalStock],
    );
    await tx.query(
      `update integration_outbox set status = 'cancelado', note = 'resolvido manualmente' where link_id = $1 and status = 'conflito'`,
      [link.id],
    );
    await finish(tx, action);
  });
}

export { nowOf };
