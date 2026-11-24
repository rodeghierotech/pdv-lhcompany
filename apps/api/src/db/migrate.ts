import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;
// Chave fixa do lock consultivo que impede migrations concorrentes.
const MIGRATION_LOCK_ID = 727_001;

function migrationsDir(): URL {
  return new URL('./migrations/', import.meta.url);
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/** Aplica migrations pendentes (forward-only), cada uma em sua própria transação. */
export async function runMigrations(pool: pg.Pool): Promise<MigrationResult> {
  const dir = migrationsDir();
  const files = readdirSync(fileURLToPath(dir))
    .filter((f) => MIGRATION_FILE.test(f))
    .sort();

  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
    const done = new Set(
      (await client.query<{ name: string }>('select name from schema_migrations')).rows.map(
        (r) => r.name,
      ),
    );
    for (const file of files) {
      if (done.has(file)) {
        result.skipped.push(file);
        continue;
      }
      const sql = readFileSync(new URL(file, dir), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        result.applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Falha na migration ${file}: ${(err as Error).message}`);
      }
    }
  } finally {
    try {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    } finally {
      client.release();
    }
  }
  return result;
}
