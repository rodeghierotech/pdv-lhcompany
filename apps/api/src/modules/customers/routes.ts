import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  customerCreateSchema,
  customerListQuerySchema,
  customerUpdateSchema,
  hasPermission,
} from '@pdv/shared';
import { errors } from '../../shared/errors.js';
import { parse } from '../../shared/validate.js';
import { createCustomer, getCustomer, listCustomers, updateCustomer } from './service.js';
import type pg from 'pg';

const idParams = z.object({ id: z.string().uuid() });

export const customerRoutes: FastifyPluginAsync<{ pool: pg.Pool }> = async (app, { pool }) => {
  const read = { preHandler: app.requirePermission('customer:read') };
  const write = { preHandler: app.requirePermission('customer:write') };

  app.get('/customers', read, async (request) =>
    listCustomers(pool, parse(customerListQuerySchema, request.query)),
  );

  app.get('/customers/:id', read, async (request) => {
    const { id } = parse(idParams, request.params);
    return { customer: await getCustomer(pool, id) };
  });

  app.post('/customers', write, async (request, reply) => {
    const input = parse(customerCreateSchema, request.body);
    // Definir limite de crédito é decisão de gerente/administrador.
    if (input.creditLimitCents != null && !hasPermission(request.actor.role, 'customer:credit')) {
      throw errors.forbidden('Sem permissão para definir limite de crédito');
    }
    return reply.code(201).send({ customer: await createCustomer(pool, input, request.actor.id) });
  });

  app.patch('/customers/:id', write, async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(customerUpdateSchema, request.body);
    if ('creditLimitCents' in input && !hasPermission(request.actor.role, 'customer:credit')) {
      throw errors.forbidden('Sem permissão para alterar limite de crédito');
    }
    return { customer: await updateCustomer(pool, id, input, request.actor.id) };
  });
};
