import type pg from 'pg';
import { lockKey, many, maybeOne, one } from '../../db/pool.js';
import { PROVIDER, autoResolveIssues, openIssue } from './deps.js';
import type { ConnectionRow } from './deps.js';
import type { RemoteOrder } from './types.js';

export type ApplyOutcome =
  'obsoleto' | 'sem_efeito' | 'baixado' | 'parcial' | 'reposto' | 'cancelado_sem_baixa';

interface ItemRow {
  id: string;
  external_item_key: string;
  external_product_id: string;
  external_variant_id: string;
  quantity: number;
  stock_status: string;
  local_variant_id: string | null;
}

const itemKey = (i: RemoteOrder['items'][number], idx: number) =>
  `${i.productId}:${i.variantId}:${idx}`;

async function movement(
  tx: pg.PoolClient,
  args: {
    variantId: string;
    type: 'pedido_online' | 'estorno_pedido_online';
    delta: number;
    reason: string;
    key: string;
  },
): Promise<string> {
  const ins = await maybeOne<{ id: string }>(
    tx,
    `insert into stock_movements (variant_id, type, quantity_delta, reason, idempotency_key)
     values ($1, $2, $3, $4, $5) on conflict (idempotency_key) do nothing returning id`,
    [args.variantId, args.type, args.delta, args.reason, args.key],
  );
  if (ins) return ins.id;
  return (
    await one<{ id: string }>(tx, 'select id from stock_movements where idempotency_key = $1', [
      args.key,
    ])
  ).id;
}

/**
 * Aplica o ESTADO ATUAL do pedido (buscado na API), não o evento recebido: por isso eventos
 * repetidos, fora de ordem ou atrasados convergem para o mesmo resultado, e cada item é baixado
 * no máximo uma vez (chave de idempotência por item + estado do item).
 */
export async function applyOrderSnapshot(
  tx: pg.PoolClient,
  conn: ConnectionRow,
  order: RemoteOrder,
): Promise<ApplyOutcome> {
  await lockKey(tx, `nuvemshop-order:${conn.external_store_id}:${order.id}`);

  const existing = await maybeOne<{ id: string; remote_updated_at: Date | null }>(
    tx,
    'select id, remote_updated_at from online_orders where provider = $1 and external_order_id = $2 for update',
    [PROVIDER, order.id],
  );
  const remoteUpdated = order.updatedAt ? new Date(order.updatedAt) : null;
  if (existing?.remote_updated_at && remoteUpdated && remoteUpdated < existing.remote_updated_at) {
    return 'obsoleto'; // instantâneo mais antigo que o já aplicado
  }

  const row = await one<{ id: string }>(
    tx,
    `insert into online_orders (provider, external_order_id, external_number, status, payment_status,
                                total_cents, paid_at, cancelled_at, cancel_reason, remote_updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (provider, external_order_id) do update
       set external_number = excluded.external_number, status = excluded.status,
           payment_status = excluded.payment_status, total_cents = excluded.total_cents,
           paid_at = excluded.paid_at, cancelled_at = excluded.cancelled_at,
           cancel_reason = excluded.cancel_reason,
           remote_updated_at = coalesce(excluded.remote_updated_at, online_orders.remote_updated_at),
           updated_at = now()
     returning id`,
    [
      PROVIDER,
      order.id,
      order.number,
      order.status,
      order.paymentStatus,
      order.totalCents,
      order.paidAt,
      order.cancelledAt,
      order.cancelReason,
      remoteUpdated,
    ],
  );
  const orderId = row.id;
  const label = order.number ?? order.id;

  // Itens: gravados na primeira vez. Se mudarem depois de haver baixa, exige revisão humana.
  let items = await many<ItemRow>(
    tx,
    'select * from online_order_items where order_id = $1 order by external_item_key',
    [orderId],
  );
  const incoming = order.items.map((i, idx) => ({ key: itemKey(i, idx), i }));
  const same =
    items.length === incoming.length &&
    incoming.every((n) =>
      items.some((o) => o.external_item_key === n.key && o.quantity === n.i.quantity),
    );
  if (!same) {
    const touched = items.some(
      (o) => o.stock_status === 'baixado' || o.stock_status === 'devolvido',
    );
    if (touched) {
      await openIssue(tx, {
        kind: 'pedido_editado',
        dedupeKey: `order-edited:${order.id}`,
        title: `Pedido #${label} foi editado depois da baixa de estoque`,
        details: { orderId: order.id, items: order.items },
        orderId,
      });
    } else {
      await tx.query('delete from online_order_items where order_id = $1', [orderId]);
      for (const n of incoming) {
        await tx.query(
          `insert into online_order_items (order_id, external_item_key, external_product_id, external_variant_id, sku, quantity)
           values ($1, $2, $3, $4, $5, $6)`,
          [orderId, n.key, n.i.productId, n.i.variantId, n.i.sku, n.i.quantity],
        );
      }
      items = await many<ItemRow>(
        tx,
        'select * from online_order_items where order_id = $1 order by external_item_key',
        [orderId],
      );
    }
  }

  const paid = order.paymentStatus === 'paid';
  const cancelled = order.status === 'cancelled';

  // --- Cancelado: repõe só o que foi baixado (e se a regra comercial exigir); descarta o resto.
  if (cancelled) {
    let restocked = 0;
    for (const it of items) {
      if (it.stock_status === 'baixado' && it.local_variant_id) {
        if (conn.restock_on_cancel) {
          const mid = await movement(tx, {
            variantId: it.local_variant_id,
            type: 'estorno_pedido_online',
            delta: it.quantity,
            reason: `Cancelamento do pedido online #${label}`,
            key: `nuvemshop:order:${conn.external_store_id}:${order.id}:${it.external_item_key}:reposicao`,
          });
          await tx.query(
            "update online_order_items set stock_status = 'devolvido', restock_movement_id = $2 where id = $1",
            [it.id, mid],
          );
          restocked++;
        }
      } else if (['pendente', 'sem_estoque', 'nao_mapeado'].includes(it.stock_status)) {
        await tx.query(
          "update online_order_items set stock_status = 'nao_aplicavel' where id = $1",
          [it.id],
        );
      }
    }
    await autoResolveIssues(tx, `%:${order.id}:%`, `pedido #${label} cancelado`);
    await autoResolveIssues(tx, `%:${order.id}`, `pedido #${label} cancelado`);
    return restocked > 0 ? 'reposto' : 'cancelado_sem_baixa';
  }

  // --- Pago e não cancelado: baixa cada item uma vez.
  if (paid) {
    let done = 0;
    let blocked = 0;
    for (const it of items) {
      // `sem_estoque` aguarda decisão humana (baixar agora / ignorar): reprocessar sozinho poderia
      // baixar em dobro quando o operador já acertou o estoque (ex.: aceitar o saldo da loja).
      if (
        it.stock_status === 'baixado' ||
        it.stock_status === 'devolvido' ||
        it.stock_status === 'nao_aplicavel' ||
        it.stock_status === 'sem_estoque'
      )
        continue;
      const link = await maybeOne<{ local_variant_id: string }>(
        tx,
        `select local_variant_id from external_variant_links
         where provider = $1 and external_variant_id = $2 and status = 'ativo'`,
        [PROVIDER, it.external_variant_id],
      );
      if (!link) {
        await tx.query("update online_order_items set stock_status = 'nao_mapeado' where id = $1", [
          it.id,
        ]);
        await openIssue(tx, {
          kind: 'item_nao_mapeado',
          dedupeKey: `unmapped:${order.id}:${it.external_item_key}`,
          title: `Pedido #${label}: item sem vínculo com produto local`,
          details: {
            orderId: order.id,
            productId: it.external_product_id,
            variantId: it.external_variant_id,
            quantity: it.quantity,
          },
          orderId,
        });
        blocked++;
        continue;
      }
      const level = await maybeOne<{ quantity: number }>(
        tx,
        'select quantity from stock_levels where variant_id = $1 for update',
        [link.local_variant_id],
      );
      const available = level?.quantity ?? 0;
      if (available < it.quantity) {
        await tx.query(
          "update online_order_items set stock_status = 'sem_estoque', local_variant_id = $2 where id = $1",
          [it.id, link.local_variant_id],
        );
        await openIssue(tx, {
          kind: 'sem_estoque',
          dedupeKey: `nostock:${order.id}:${it.external_item_key}`,
          title: `Pedido pago #${label} sem estoque local suficiente`,
          details: {
            orderId: order.id,
            variantId: link.local_variant_id,
            required: it.quantity,
            available,
          },
          orderId,
        });
        blocked++;
        continue;
      }
      const mid = await movement(tx, {
        variantId: link.local_variant_id,
        type: 'pedido_online',
        delta: -it.quantity,
        reason: `Pedido online #${label}`,
        key: `nuvemshop:order:${conn.external_store_id}:${order.id}:${it.external_item_key}:baixa`,
      });
      await tx.query(
        "update online_order_items set stock_status = 'baixado', local_variant_id = $2, deduct_movement_id = $3 where id = $1",
        [it.id, link.local_variant_id, mid],
      );
      await autoResolveIssues(tx, `%:${order.id}:${it.external_item_key}`, 'baixa realizada');
      done++;
    }
    return blocked > 0
      ? done > 0
        ? 'parcial'
        : 'sem_efeito'
      : done > 0
        ? 'baixado'
        : 'sem_efeito';
  }

  // --- Reembolso/anulação de pedido já baixado: revisão humana (nunca estorno automático).
  if (
    ['refunded', 'partially_refunded', 'voided'].includes(order.paymentStatus) &&
    items.some((i) => i.stock_status === 'baixado')
  ) {
    await openIssue(tx, {
      kind: 'reembolso_revisar',
      dedupeKey: `refund:${order.id}`,
      title: `Pedido #${label} com pagamento ${order.paymentStatus} após baixa de estoque`,
      details: { orderId: order.id, paymentStatus: order.paymentStatus },
      orderId,
    });
  }
  // Não pago: nada muda no estoque local.
  return 'sem_efeito';
}
