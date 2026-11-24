import { loadEnv } from '../config/env.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';

const env = loadEnv();
const pool = createPool(env.DATABASE_URL_MIGRATIONS ?? env.DATABASE_URL);

try {
  const { applied, skipped } = await runMigrations(pool);
  console.log(`Migrations aplicadas: ${applied.length ? applied.join(', ') : 'nenhuma'}`);
  console.log(`Já existentes: ${skipped.length}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
