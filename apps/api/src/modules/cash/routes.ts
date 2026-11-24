import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  cashCloseSchema,
  cashMovementReverseSchema,
  cashMovementSchema,
  cashOpenSchema,
  cashSessionListQuerySchema,
  paginationQuerySchema,
} from '@pdv/shared';
import { parse } from '../../shared/validate.js';
import {
  closeSession,
  createMovement,
  getCurrentSession,
  getLedger,
  getReport,
  getSession,
  listSessions,
  openSession,
  reverseMovement,
} from './service.js';
import type pg from 'pg';

const idParams = z.object({ id: z.string().uuid() });

export const cashRoutes: FastifyPluginAsync<{ pool: pg.Pool }> = async (app, { pool }) => {
  const read = { preHandler: app.requirePermission('cash:read') };

  app.get('/cash/current', read, async (request) => {
    const session = await getCurrentSession(pool, request.actor.id);
    return { session, report: session ? await getReport(pool, session.id) : null };
  });

  app.post(
    '/cash/open',
    { preHandler: app.requirePermission('cash:open') },
    async (request, reply) => {
      const input = parse(cashOpenSchema, request.body);
      const result = await openSession(pool, input, request.actor);
      return reply.code(result.created ? 201 : 200).send({ session: result.session });
    },
  );

  app.get('/cash/sessions', read, async (request) =>
    listSessions(pool, parse(cashSessionListQuerySchema, request.query), request.actor),
  );

  app.get('/cash/sessions/:id', read, async (request) => {
    const { id } = parse(idParams, request.params);
    const session = await getSession(pool, id, request.actor);
    return { session, report: await getReport(pool, id) };
  });

  app.get('/cash/sessions/:id/movements', read, async (request) => {
    const { id } = parse(idParams, request.params);
    return getLedger(pool, id, parse(paginationQuerySchema, request.query), request.actor);
  });

  app.post(
    '/cash/sessions/:id/close',
    { preHandler: app.requirePermission('cash:close') },
    async (request, reply) => {
      const { id } = parse(idParams, request.params);
      const input = parse(cashCloseSchema, request.body);
      const result = await closeSession(pool, id, input, request.actor);
      return reply.code(result.created ? 201 : 200).send({
        session: result.session,
        report: await getReport(pool, id),
      });
    },
  );

  app.post(
    '/cash/movements',
    { preHandler: app.requirePermission('cash:movement') },
    async (request, reply) => {
      const input = parse(cashMovementSchema, request.body);
      const result = await createMovement(pool, input, request.actor);
      return reply
        .code(result.created ? 201 : 200)
        .send({ id: result.id, replayed: !result.created });
    },
  );

  app.post(
    '/cash/movements/:id/reverse',
    { preHandler: app.requirePermission('cash:manage') },
    async (request, reply) => {
      const { id } = parse(idParams, request.params);
      const input = parse(cashMovementReverseSchema, request.body);
      const result = await reverseMovement(pool, id, input, request.actor);
      return reply
        .code(result.created ? 201 : 200)
        .send({ id: result.id, replayed: !result.created });
    },
  );
};
