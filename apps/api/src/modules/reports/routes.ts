import type { FastifyPluginAsync } from 'fastify';
import { reportRangeSchema, topProductsQuerySchema } from '@pdv/shared';
import { parse } from '../../shared/validate.js';
import { recordAudit } from '../audit/service.js';
import {
  exportPaymentsCsv,
  exportSalesCsv,
  getDaily,
  getRecent,
  getSellers,
  getSummary,
  getTopProducts,
  resolvePeriod,
} from './service.js';
import type pg from 'pg';

export const reportRoutes: FastifyPluginAsync<{ pool: pg.Pool }> = async (app, { pool }) => {
  const read = { preHandler: app.requirePermission('report:read') };

  app.get('/reports/summary', read, async (request) => ({
    summary: await getSummary(pool, parse(reportRangeSchema, request.query)),
  }));

  app.get('/reports/daily', read, async (request) => ({
    items: await getDaily(pool, parse(reportRangeSchema, request.query)),
  }));

  app.get('/reports/top-products', read, async (request) => {
    const { limit, ...range } = parse(topProductsQuerySchema, request.query);
    return { items: await getTopProducts(pool, range, limit) };
  });

  app.get('/reports/sellers', read, async (request) => ({
    items: await getSellers(pool, parse(reportRangeSchema, request.query)),
  }));

  app.get('/reports/recent', read, async () => ({ items: await getRecent(pool) }));

  for (const [kind, build] of [
    ['sales', exportSalesCsv],
    ['payments', exportPaymentsCsv],
  ] as const) {
    app.get(`/reports/${kind}.csv`, read, async (request, reply) => {
      const range = parse(reportRangeSchema, request.query);
      const csv = await build(pool, range);
      const period = await resolvePeriod(pool, range);
      await recordAudit(pool, {
        actorId: request.actor.id,
        action: 'report.export',
        entity: 'report',
        payload: { kind, ...period },
      });
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="${kind}-${period.from}_${period.to}.csv"`,
        )
        .header('cache-control', 'no-store')
        .send(csv);
    });
  }
};
