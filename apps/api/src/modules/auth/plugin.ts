import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { hasPermission } from '@pdv/shared';
import type { Permission, Role, UserDTO } from '@pdv/shared';
import type { Env } from '../../config/env.js';
import { errors } from '../../shared/errors.js';
import { getActiveUser } from './service.js';
import type pg from 'pg';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: Role };
    user: { sub: string; role: Role };
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Usuário autenticado, recarregado do banco a cada requisição (papel e status atuais). */
    actor: UserDTO;
  }
  interface FastifyInstance {
    requireAuth: preHandlerHookHandler;
    requirePermission: (permission: Permission) => preHandlerHookHandler;
    signAccessToken: (user: UserDTO) => string;
  }
}

interface Options {
  env: Env;
  pool: pg.Pool;
}

export const authPlugin = fp<Options>(async (app, { env, pool }) => {
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.ACCESS_TOKEN_TTL, algorithm: 'HS256' },
    verify: { algorithms: ['HS256'] },
  });

  app.decorateRequest('actor');

  const requireAuth: preHandlerHookHandler = async (request: FastifyRequest) => {
    try {
      await request.jwtVerify();
    } catch {
      throw errors.unauthorized('Sessão inválida ou expirada');
    }
    const user = await getActiveUser(pool, request.user.sub);
    if (!user) throw errors.unauthorized('Usuário inativo ou inexistente');
    request.actor = user;
  };

  app.decorate('requireAuth', requireAuth);
  app.decorate('requirePermission', (permission: Permission): preHandlerHookHandler => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth.call(app, request, reply, () => undefined);
      if (!hasPermission(request.actor.role, permission)) throw errors.forbidden();
    };
  });
  app.decorate('signAccessToken', (user: UserDTO) =>
    app.jwt.sign({ sub: user.id, role: user.role }),
  );
});
