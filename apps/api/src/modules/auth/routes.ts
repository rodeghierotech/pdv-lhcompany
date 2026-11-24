import type { FastifyPluginAsync } from 'fastify';
import { loginSchema, userCreateSchema } from '@pdv/shared';
import { parse } from '../../shared/validate.js';
import { authenticate, createUser } from './service.js';
import type pg from 'pg';

export const authRoutes: FastifyPluginAsync<{ pool: pg.Pool; loginRateLimit?: number }> = async (
  app,
  { pool, loginRateLimit = 10 },
) => {
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: loginRateLimit, timeWindow: '1 minute' } } },
    async (request) => {
      const { email, password } = parse(loginSchema, request.body);
      const user = await authenticate(pool, email, password);
      return { token: app.signAccessToken(user), user };
    },
  );

  app.get('/auth/me', { preHandler: app.requireAuth }, async (request) => ({
    user: request.actor,
  }));

  app.post(
    '/users',
    { preHandler: app.requirePermission('user:manage') },
    async (request, reply) => {
      const input = parse(userCreateSchema, request.body);
      const user = await createUser(pool, input, request.actor.id);
      return reply.code(201).send({ user });
    },
  );
};
