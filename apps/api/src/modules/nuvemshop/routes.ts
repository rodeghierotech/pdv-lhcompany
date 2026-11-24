import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { many } from '../../db/pool.js';
import { errors } from '../../shared/errors.js';
import { parse } from '../../shared/validate.js';
import {
  completeAuthorization,
  createInstallUrl,
  disconnect,
  getStatus,
  registerWebhooks,
  setRestockOnCancel,
} from './connection.js';
import {
  handleLifecycleEvent,
  ingestWebhook,
  retryEvent,
  verifyWebhookSignature,
} from './events.js';
import type { WebhookPayload } from './events.js';
import { createLink, importCatalog, listLinkOverview, removeLink } from './links.js';
import { retryOutbox } from './outbox.js';
import { reconcileStock, resolveIssue, sweepOrders } from './reconcile.js';
import { runCycle } from './worker.js';
import type { NuvemshopDeps } from './deps.js';

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  status: z.string().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const nuvemshopRoutes: FastifyPluginAsync<{ deps: NuvemshopDeps }> = async (
  app,
  { deps },
) => {
  const read = { preHandler: app.requirePermission('integration:read') };
  const manage = { preHandler: app.requirePermission('integration:manage') };
  const admin = { preHandler: app.requirePermission('integration:admin') };
  const base = '/integrations/nuvemshop';

  // Webhook: corpo CRU para o HMAC; contexto encapsulado para não afetar as demais rotas.
  await app.register(async (hook) => {
    hook.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body),
    );
    hook.post(
      `${base}/webhooks`,
      { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const secret = deps.env.NUVEMSHOP_CLIENT_SECRET;
        if (!secret)
          return reply.code(503).send({
            error: { code: 'APP_CREDENTIALS_MISSING', message: 'Integração não configurada' },
          });
        const raw = typeof request.body === 'string' ? request.body : '';
        if (
          !verifyWebhookSignature(
            raw,
            request.headers['x-linkedstore-hmac-sha256'] as string | undefined,
            secret,
          )
        ) {
          return reply
            .code(401)
            .send({ error: { code: 'INVALID_SIGNATURE', message: 'Assinatura inválida' } });
        }
        let payload: WebhookPayload;
        try {
          payload = JSON.parse(raw) as WebhookPayload;
        } catch {
          return reply
            .code(400)
            .send({ error: { code: 'VALIDATION_ERROR', message: 'JSON inválido' } });
        }
        if (!payload || typeof payload.event !== 'string' || payload.store_id === undefined) {
          return reply
            .code(400)
            .send({ error: { code: 'VALIDATION_ERROR', message: 'Payload inesperado' } });
        }
        if (await handleLifecycleEvent(deps, payload)) return reply.code(200).send({ ok: true });
        const result = await ingestWebhook(deps, raw, payload);
        return reply.code(200).send({ ok: true, result });
      },
    );
  });

  // Retorno do OAuth (navegador da loja): autenticado pelo `state` de uso único.
  app.get(`${base}/callback`, async (request, reply) => {
    const q = parse(
      z.object({ code: z.string().min(1).max(500), state: z.string().min(10).max(200) }),
      request.query,
    );
    await completeAuthorization(deps, q);
    const web = (deps.env.WEB_URL ?? '').replace(/\/$/, '');
    return reply.redirect(`${web}/integracoes?conectado=1`);
  });

  app.get(`${base}/status`, read, async () => getStatus(deps));
  app.post(`${base}/install-url`, manage, async (request) =>
    createInstallUrl(deps, request.actor.id),
  );
  app.post(`${base}/webhooks/register`, admin, async (request) =>
    registerWebhooks(deps, request.actor.id),
  );
  app.post(`${base}/disconnect`, admin, async (request, reply) => {
    await disconnect(deps, request.actor.id);
    return reply.code(204).send();
  });
  app.patch(`${base}/settings`, admin, async (request) => {
    const { restockOnCancel } = parse(z.object({ restockOnCancel: z.boolean() }), request.body);
    await setRestockOnCancel(deps, request.actor.id, restockOnCancel);
    return { restockOnCancel };
  });

  app.post(`${base}/catalog/import`, manage, async () => importCatalog(deps));
  app.get(`${base}/links`, read, async (request) => {
    const q = parse(
      z.object({
        filter: z.enum(['todos', 'vinculados', 'nao_vinculados']).default('todos'),
        q: z.string().max(100).optional(),
      }),
      request.query,
    );
    return { items: await listLinkOverview(deps, q.filter, q.q) };
  });
  app.post(`${base}/links`, manage, async (request, reply) => {
    const input = parse(
      z.object({ variantId: z.string().uuid(), externalVariantId: z.string().min(1).max(40) }),
      request.body,
    );
    return reply.code(201).send(await createLink(deps, request.actor.id, input));
  });
  app.delete(`${base}/links/:id`, manage, async (request, reply) => {
    await removeLink(deps, request.actor.id, parse(idParams, request.params).id);
    return reply.code(204).send();
  });

  // Reconciliação/varredura manual (executa um ciclo completo imediatamente).
  app.post(`${base}/sync-now`, manage, async () => runCycle(deps, { forceReconcile: true }));
  app.post(`${base}/reconcile`, manage, async () => ({
    stock: await reconcileStock(deps),
    orders: await sweepOrders(deps),
  }));

  app.get('/integrations/issues', read, async (request) => {
    const q = parse(
      z.object({
        status: z.enum(['aberto', 'resolvido']).default('aberto'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      request.query,
    );
    return {
      items: await many(
        deps.pool,
        `select i.id, i.kind, i.title, i.details, i.status, i.created_at as "createdAt", i.resolved_at as "resolvedAt", i.resolution,
                o.external_number as "orderNumber", o.external_order_id as "orderId", v.sku
         from integration_issues i
         left join online_orders o on o.id = i.online_order_id
         left join external_variant_links l on l.id = i.link_id
         left join product_variants v on v.id = l.local_variant_id
         where i.status = $1 order by i.created_at desc limit $2`,
        [q.status, q.limit],
      ),
    };
  });
  app.post('/integrations/issues/:id/resolve', manage, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const body = parse(
      z.object({
        action: z.enum(['aceitar_remoto', 'enviar_local', 'baixar_agora', 'ignorar']),
        note: z.string().max(500).optional(),
      }),
      request.body,
    );
    await resolveIssue(deps, id, body.action, request.actor.id, body.note);
    return reply.code(204).send();
  });

  app.get('/integrations/events', read, async (request) => {
    const q = parse(listQuery, request.query);
    return {
      items: await many(
        deps.pool,
        `select id, source, event, entity_id as "entityId", status, attempts, last_error as "lastError", received_at as "receivedAt",
                processed_at as "processedAt", next_attempt_at as "nextAttemptAt"
         from integration_events where ($1::text is null or status = $1) order by received_at desc limit $2`,
        [q.status ?? null, q.limit],
      ),
    };
  });
  app.post('/integrations/events/:id/retry', manage, async (request, reply) => {
    if (!(await retryEvent(deps, parse(idParams, request.params).id, request.actor.id))) {
      throw errors.conflict('NOT_RETRYABLE', 'Evento não está em falha/ignorado');
    }
    return reply.code(204).send();
  });

  app.get('/integrations/outbox', read, async (request) => {
    const q = parse(listQuery, request.query);
    return {
      items: await many(
        deps.pool,
        `select o.id, o.status, o.delta, o.attempts, o.last_error as "lastError", o.note, o.created_at as "createdAt",
                o.sent_at as "sentAt", o.next_attempt_at as "nextAttemptAt", v.sku
         from integration_outbox o join product_variants v on v.id = o.variant_id
         where ($1::text is null or o.status = $1) order by o.created_at desc limit $2`,
        [q.status ?? null, q.limit],
      ),
    };
  });
  app.post('/integrations/outbox/:id/retry', manage, async (request, reply) => {
    if (!(await retryOutbox(deps, parse(idParams, request.params).id, request.actor.id))) {
      throw errors.conflict('NOT_RETRYABLE', 'Item não está em falha/conflito');
    }
    return reply.code(204).send();
  });

  app.get('/integrations/orders', read, async (request) => {
    const q = parse(listQuery, request.query);
    return {
      items: await many(
        deps.pool,
        `select o.id, o.external_order_id as "orderId", o.external_number as "number", o.status, o.payment_status as "paymentStatus",
                o.total_cents as "totalCents", o.paid_at as "paidAt", o.cancelled_at as "cancelledAt", o.remote_updated_at as "remoteUpdatedAt",
                coalesce(json_agg(json_build_object('sku', i.sku, 'quantity', i.quantity, 'stockStatus', i.stock_status) order by i.external_item_key), '[]') as items
         from online_orders o left join online_order_items i on i.order_id = o.id
         group by o.id order by o.first_seen_at desc limit $1`,
        [q.limit],
      ),
    };
  });
};
