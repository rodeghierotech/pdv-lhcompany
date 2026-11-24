import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { discountLimitUpdateSchema, ROLES } from '@pdv/shared';
import { parse } from '../../shared/validate.js';
import { listDiscountLimits, updateDiscountLimit } from './service.js';
import type pg from 'pg';

const roleParams = z.object({ role: z.enum(ROLES) });

export const settingsRoutes: FastifyPluginAsync<{ pool: pg.Pool }> = async (app, { pool }) => {
  // Quem vende precisa conhecer os limites para exibir/validar descontos na tela.
  app.get(
    '/settings/discount-limits',
    { preHandler: app.requirePermission('sale:create') },
    async () => ({
      items: await listDiscountLimits(pool),
    }),
  );

  app.put(
    '/settings/discount-limits/:role',
    { preHandler: app.requirePermission('settings:manage') },
    async (request) => {
      const { role } = parse(roleParams, request.params);
      const { maxDiscountBp } = parse(discountLimitUpdateSchema, request.body);
      return { limit: await updateDiscountLimit(pool, role, maxDiscountBp, request.actor.id) };
    },
  );
};
