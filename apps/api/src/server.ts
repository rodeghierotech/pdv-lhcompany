import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createPool } from './db/pool.js';

const env = loadEnv();
// Erros de conexões ociosas do pool (ex.: Neon encerrando conexões) são registrados, não fatais.
const pool = createPool(env.DATABASE_URL, (err) =>
  console.error('erro no pool de conexões:', err.message),
);
const app = await buildApp({ env, pool });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'encerrando');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error({ err }, 'falha ao iniciar');
  process.exit(1);
}
