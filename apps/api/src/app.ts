import Fastify from 'fastify';
import type { FastifyError, FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type pg from 'pg';
import { ZodError } from 'zod';
import type { Env } from './config/env.js';
import { authPlugin } from './modules/auth/plugin.js';
import { authRoutes } from './modules/auth/routes.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { cashRoutes } from './modules/cash/routes.js';
import { customerRoutes } from './modules/customers/routes.js';
import { debtRoutes } from './modules/debts/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { inventoryRoutes } from './modules/inventory/routes.js';
import { salesRoutes } from './modules/sales/routes.js';
import { syncRoutes } from './modules/sync/routes.js';
import { createNuvemshopDeps } from './modules/nuvemshop/index.js';
import type { NuvemshopDeps } from './modules/nuvemshop/index.js';
import { nuvemshopRoutes } from './modules/nuvemshop/routes.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { AppError } from './shared/errors.js';

export interface BuildOptions {
  env: Env;
  pool: pg.Pool;
  /** Substituições para testes (adaptador falso, relógio). */
  nuvemshop?: Partial<NuvemshopDeps>;
  /** Destino dos logs (testes). */
  logStream?: NodeJS.WritableStream;
}

export const redactUrl = (url: string | undefined): string | undefined =>
  url?.replace(/([?&](?:code|state|access_token|token|client_secret)=)[^&]*/gi, '$1[redigido]');

export async function buildApp({
  env,
  pool,
  nuvemshop,
  logStream,
}: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      env.LOG_LEVEL === 'silent'
        ? false
        : {
            level: env.LOG_LEVEL,
            // Nunca registrar credenciais.
            redact: ['req.headers.authorization', 'req.headers.cookie'],
            serializers: {
              // O retorno do OAuth traz `code` e `state` na URL: nunca vão para o log.
              req: (req) => ({
                method: req.method,
                url: redactUrl(req.url),
                host: req.headers?.host,
                remoteAddress: req.ip,
              }),
            },
            ...(logStream ? { stream: logStream } : {}),
            ...(env.NODE_ENV === 'development' && !logStream
              ? { transport: { target: 'pino-pretty' } }
              : {}),
          },
    trustProxy: true, // atrás do proxy do Render
    bodyLimit: 1_048_576,
  });

  // Handlers ANTES dos plugins de rota: contextos filhos herdam o handler vigente no registro.
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada' } }),
  );

  // Tratamento centralizado de erros: formato único { error: { code, message, details? } }.
  app.setErrorHandler((err: FastifyError | AppError | ZodError, request, reply) => {
    if (err instanceof AppError) {
      return reply
        .code(err.status)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: { code: 'VALIDATION_ERROR', message: 'Dados inválidos' } });
    }
    const status = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err }, 'erro não tratado');
      return reply
        .code(500)
        .send({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno do servidor' } });
    }
    const code = status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST';
    const message = status === 429 ? 'Muitas tentativas. Aguarde e tente novamente.' : err.message;
    return reply.code(status).send({ error: { code, message } });
  });

  await app.register(cors, {
    origin: env.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['content-disposition'],
  });
  await app.register(rateLimit, { global: false });
  await app.register(authPlugin, { env, pool });

  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('select 1');
      return { status: 'ok' };
    } catch (err) {
      app.log.error({ err }, 'health check falhou');
      return reply.code(503).send({ status: 'degraded' });
    }
  });

  await app.register(authRoutes, { pool, loginRateLimit: env.LOGIN_RATE_LIMIT });
  await app.register(catalogRoutes, { pool });
  await app.register(inventoryRoutes, { pool });
  await app.register(customerRoutes, { pool });
  await app.register(settingsRoutes, { pool });
  await app.register(salesRoutes, { pool });
  await app.register(cashRoutes, { pool });
  await app.register(debtRoutes, { pool });
  await app.register(reportRoutes, { pool });
  await app.register(syncRoutes, { pool, env });
  await app.register(nuvemshopRoutes, { deps: createNuvemshopDeps(pool, env, nuvemshop) });

  return app;
}
