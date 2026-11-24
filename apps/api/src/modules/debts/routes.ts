import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  debtListQuerySchema,
  debtReceiptReverseSchema,
  debtReceiptSchema,
  paginationQuerySchema,
} from '@pdv/shared';
import { parse } from '../../shared/validate.js';
import {
  getCustomerAccount,
  getReceipt,
  listCustomerPayments,
  listOpenDebts,
  receiveDebt,
  reverseReceipt,
} from './service.js';
import type pg from 'pg';

const idParams = z.object({ id: z.string().uuid() });

export const debtRoutes: FastifyPluginAsync<{ pool: pg.Pool }> = async (app, { pool }) => {
  const read = { preHandler: app.requirePermission('customer:read') };
  const receive = { preHandler: app.requirePermission('debt:receive') };

  app.get('/debts', read, async (request) =>
    listOpenDebts(pool, parse(debtListQuerySchema, request.query)),
  );

  app.get('/customers/:id/account', read, async (request) => {
    const { id } = parse(idParams, request.params);
    return getCustomerAccount(pool, id);
  });

  app.get('/customers/:id/payments', read, async (request) => {
    const { id } = parse(idParams, request.params);
    return listCustomerPayments(pool, id, parse(paginationQuerySchema, request.query));
  });

  // Recebe do saldo geral do cliente (mais antigas primeiro).
  app.post('/customers/:id/receipts', receive, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const input = parse(debtReceiptSchema, request.body);
    const result = await receiveDebt(pool, id, null, input, request.actor);
    return reply
      .code(result.created ? 201 : 200)
      .send({ receipt: result.receipt, replayed: !result.created });
  });

  // Recebe o saldo de uma venda específica.
  app.post('/sales/:id/receipts', receive, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const input = parse(debtReceiptSchema, request.body);
    const sale = await pool.query<{ customer_id: string | null }>(
      'select customer_id from sales where id = $1',
      [id],
    );
    const customerId = sale.rows[0]?.customer_id;
    if (!sale.rows[0])
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Venda: não encontrado' } });
    if (!customerId) {
      return reply.code(422).send({
        error: { code: 'NO_BALANCE', message: 'Venda sem cliente não possui saldo a receber' },
      });
    }
    const result = await receiveDebt(pool, customerId, id, input, request.actor);
    return reply
      .code(result.created ? 201 : 200)
      .send({ receipt: result.receipt, replayed: !result.created });
  });

  app.get('/receipts/:id', read, async (request) => {
    const { id } = parse(idParams, request.params);
    return { receipt: await getReceipt(pool, id) };
  });

  app.post(
    '/receipts/:id/reverse',
    { preHandler: app.requirePermission('debt:reverse') },
    async (request, reply) => {
      const { id } = parse(idParams, request.params);
      const input = parse(debtReceiptReverseSchema, request.body);
      const result = await reverseReceipt(pool, id, input, request.actor);
      return reply
        .code(result.created ? 201 : 200)
        .send({ receipt: result.receipt, replayed: !result.created });
    },
  );
};
