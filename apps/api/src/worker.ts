import { loadEnv } from './config/env.js';
import { createPool } from './db/pool.js';
import { createNuvemshopDeps, startWorker } from './modules/nuvemshop/index.js';

const env = loadEnv();
const pool = createPool(env.DATABASE_URL, (err) =>
  console.error('erro no pool de conexões:', err.message),
);
const stop = startWorker(createNuvemshopDeps(pool, env));
console.error('worker Nuvemshop iniciado');

const shutdown = async () => {
  stop();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
