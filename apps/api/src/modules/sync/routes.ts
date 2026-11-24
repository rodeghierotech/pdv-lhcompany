import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  hasPermission,
  offlineGrantRequestSchema,
  syncRequestSchema,
  syncResolveSchema,
} from '@pdv/shared';
import type { Env } from '../../config/env.js';
import { errors } from '../../shared/errors.js';
import { parse } from '../../shared/validate.js';
import { getActiveUser } from '../auth/service.js';
import { recordAudit } from '../audit/service.js';
import { createGrantSigner } from './grant.js';
import {
  acknowledgeConflicts,
  getCatalogSnapshot,
  listIssues,
  processOperations,
  registerDevice,
  resolveOperation,
} from './service.js';
import type pg from 'pg';

const idParams = z.object({ id: z.string().uuid() });

export const syncRoutes: FastifyPluginAsync<{ pool: pg.Pool; env: Env }> = async (
  app,
  { pool, env },
) => {
  const signer = createGrantSigner(env.JWT_SECRET);
  const sell = { preHandler: app.requirePermission('sale:create') };
  const resolve = { preHandler: app.requirePermission('sync:resolve') };

  // Emissão da autorização offline: exige sessão online válida e não é renovável offline.
  app.post('/auth/offline-grant', sell, async (request) => {
    const { deviceId } = parse(offlineGrantRequestSchema, request.body);
    await registerDevice(pool, deviceId, request.actor.id);
    const { grant, claims } = signer.issue(request.actor, deviceId);
    await recordAudit(pool, {
      actorId: request.actor.id,
      action: 'sync.grant',
      entity: 'device',
      entityId: deviceId,
      payload: { jti: claims.jti, expiresAt: new Date(claims.exp).toISOString() },
    });
    return {
      grant,
      issuedAt: new Date(claims.iat).toISOString(),
      expiresAt: new Date(claims.exp).toISOString(),
    };
  });

  app.get('/sync/catalog', sell, async (request) => getCatalogSnapshot(pool, request.actor));

  // Autenticada pela autorização assinada (o JWT pode ter expirado durante a queda de conexão).
  app.post(
    '/sync/operations',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const input = parse(syncRequestSchema, request.body);
      const claims = signer.verify(input.grant);
      if (claims.did !== input.deviceId)
        throw errors.unauthorized('Autorização de outro dispositivo');
      const user = await getActiveUser(pool, claims.sub);
      if (!user) throw errors.unauthorized('Usuário inativo ou inexistente');
      if (!hasPermission(user.role, 'sale:create')) throw errors.forbidden();
      const results = await processOperations(
        pool,
        { claims, deviceId: input.deviceId, user },
        input.operations,
      );
      return { results };
    },
  );

  app.get('/sync/issues', resolve, async () => ({ items: await listIssues(pool) }));

  app.post('/sync/operations/:id/resolve', resolve, async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(syncResolveSchema, request.body);
    return { result: await resolveOperation(pool, id, input, request.actor) };
  });

  app.post('/sync/operations/:id/acknowledge', resolve, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    await acknowledgeConflicts(pool, id, request.actor);
    return reply.code(204).send();
  });
};
