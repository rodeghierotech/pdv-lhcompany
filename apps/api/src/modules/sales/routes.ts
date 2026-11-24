import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  saleCancelSchema,
  saleCreateSchema,
  saleDueDateSchema,
  saleListQuerySchema,
  saleReturnPreviewSchema,
  saleReturnSchema,
  variantSearchQuerySchema,
} from '@pdv/shared';
import { parse } from '../../shared/validate.js';
import { searchSellableVariants } from '../catalog/service.js';
import {
  cancelSale,
  createReturn,
  createSale,
  getSale,
  listSales,
  previewReturn,
  updateSaleDueDate,
} from './service.js';
import type pg from 'pg';

const idParams = z.object({ id: z.string().uuid() });

export const salesRoutes: FastifyPluginAsync<{ pool: pg.Pool }> = async (app, { pool }) => {
  const create = { preHandler: app.requirePermission('sale:create') };
  const read = { preHandler: app.requirePermission('sale:read') };

  app.get('/pos/variants', create, async (request) => {
    const { q } = parse(variantSearchQuerySchema, request.query);
    return { items: await searchSellableVariants(pool, q) };
  });

  app.post('/sales', create, async (request, reply) => {
    const input = parse(saleCreateSchema, request.body);
    const result = await createSale(pool, input, request.actor);
    return reply
      .code(result.created ? 201 : 200)
      .send({ sale: result.sale, replayed: !result.created });
  });

  app.get('/sales', read, async (request) =>
    listSales(pool, parse(saleListQuerySchema, request.query)),
  );

  app.get('/sales/:id', read, async (request) => {
    const { id } = parse(idParams, request.params);
    return { sale: await getSale(pool, id) };
  });

  app.post(
    '/sales/:id/cancel',
    { preHandler: app.requirePermission('sale:cancel') },
    async (request, reply) => {
      const { id } = parse(idParams, request.params);
      const input = parse(saleCancelSchema, request.body);
      const result = await cancelSale(pool, id, input, request.actor);
      return reply
        .code(result.created ? 201 : 200)
        .send({ sale: result.sale, replayed: !result.created });
    },
  );

  app.post(
    '/sales/:id/returns/preview',
    { preHandler: app.requirePermission('sale:return') },
    async (request) => {
      const { id } = parse(idParams, request.params);
      const input = parse(saleReturnPreviewSchema, request.body);
      return { preview: await previewReturn(pool, id, input) };
    },
  );

  app.post(
    '/sales/:id/returns',
    { preHandler: app.requirePermission('sale:return') },
    async (request, reply) => {
      const { id } = parse(idParams, request.params);
      const input = parse(saleReturnSchema, request.body);
      const result = await createReturn(pool, id, input, request.actor);
      return reply
        .code(result.created ? 201 : 200)
        .send({ sale: result.sale, replayed: !result.created });
    },
  );

  app.patch(
    '/sales/:id/due-date',
    { preHandler: app.requirePermission('customer:credit') },
    async (request) => {
      const { id } = parse(idParams, request.params);
      const { dueDate } = parse(saleDueDateSchema, request.body);
      return { sale: await updateSaleDueDate(pool, id, dueDate, request.actor) };
    },
  );
};
