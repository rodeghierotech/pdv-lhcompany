import type { FastifyInstance } from 'fastify';
import type { Role, UserDTO } from '@pdv/shared';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { createUser } from '../src/modules/auth/service.js';
import type pg from 'pg';

export interface TestCtx {
  app: FastifyInstance;
  pool: pg.Pool;
  tokenFor: (role: Role) => string;
  users: Record<Role, UserDTO>;
  close: () => Promise<void>;
}

export const TEST_PASSWORD = 'senha-segura-123';

export async function setup(): Promise<TestCtx> {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET,
  });
  // Trava de segurança: este setup apaga o schema, então só roda em bancos de teste.
  const dbName = new URL(env.DATABASE_URL).pathname.replace('/', '');
  if (!dbName.endsWith('_test')) {
    throw new Error(`Recusando rodar testes no banco "${dbName}": o nome deve terminar em _test`);
  }
  const pool = createPool(env.DATABASE_URL);
  // Banco limpo a cada arquivo de teste, reaplicando as migrations reais.
  await pool.query('drop schema public cascade; create schema public;');
  await runMigrations(pool);

  const users = {} as Record<Role, UserDTO>;
  for (const role of ['admin', 'gerente', 'vendedor'] as const) {
    users[role] = await createUser(
      pool,
      { name: `Teste ${role}`, email: `${role}@teste.com`, password: TEST_PASSWORD, role },
      null,
    );
  }
  const app = await buildApp({ env, pool });
  await app.ready();
  return {
    app,
    pool,
    users,
    tokenFor: (role) => app.signAccessToken(users[role]),
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let cashSeq = 0;
/** Abre um caixa para o operador do token (idempotente por chave única) e devolve o id. */
export async function openCash(ctx: TestCtx, token: string, openingCents = 0): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/cash/open',
    headers: auth(token),
    payload: { idempotencyKey: `open-key-${Date.now()}-${++cashSeq}`, openingCents },
  });
  if (res.statusCode !== 201) throw new Error(`abertura de caixa falhou: ${res.body}`);
  return res.json().session.id as string;
}
