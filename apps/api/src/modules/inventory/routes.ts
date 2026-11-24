import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  movementListQuerySchema,
  stockAdjustSchema,
  stockEntrySchema,
  stockReverseSchema,
} from '@pdv/shared';
import { parse } from '../../shared/validate.js';
import {
  listLowStock,
  listMovements,
  registerAdjustment,
  registerEntry,
  reverseMovement,
} from './service.js';
import type pg from 'pg';

const idParams = z.object({ id: z.string().uuid() });

export const inventoryRoutes: FastifyPluginAsync<{ pool: pg.Pool }> = async (app, { pool }) => {
  app.get('/stock/movements', { preHandler: app.requirePermission('stock:read') }, async (req) =>
    listMovements(pool, parse(movementListQuerySchema, req.query)),
  );

  app.get('/stock/low', { preHandler: app.requirePermission('stock:read') }, async () => ({
    items: await listLowStock(pool),
  }));

  app.post(
    '/stock/entries',
    { preHandler: app.requirePermission('stock:entry') },
    async (request, reply) => {
      const input = parse(stockEntrySchema, request.body);
      const result = await registerEntry(pool, input, request.actor.id);
      return reply.code(result.created ? 201 : 200).send({ ...result, replayed: !result.created });
    },
  );

  app.post(
    '/stock/adjustments',
    { preHandler: app.requirePermission('stock:adjust') },
    async (request, reply) => {
      const input = parse(stockAdjustSchema, request.body);
      const result = await registerAdjustment(pool, input, request.actor.id);
      return reply.code(result.created ? 201 : 200).send({ ...result, replayed: !result.created });
    },
  );

  app.post(
    '/stock/movements/:id/reverse',
    { preHandler: app.requirePermission('stock:adjust') },
    async (request, reply) => {
      const { id } = parse(idParams, request.params);
      const input = parse(stockReverseSchema, request.body);
      const result = await reverseMovement(pool, id, input, request.actor.id);
      return reply.code(result.created ? 201 : 200).send({ ...result, replayed: !result.created });
    },
  );
};
