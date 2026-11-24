import pg from 'pg';

export type Db = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, onError?: (err: Error) => void): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    // Neon encerra conexões ociosas; evita reutilizar conexões mortas.
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  });
  // Erros em conexões ociosas não podem derrubar o processo.
  pool.on('error', (err) => onError?.(err));
  return pool;
}

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      // conexão já perdida; o erro original é o relevante
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Serializa operações com a mesma chave dentro da transação (idempotência sem corrida). */
export async function lockKey(client: pg.PoolClient, key: string): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

export async function many<T extends pg.QueryResultRow>(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function maybeOne<T extends pg.QueryResultRow>(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const res = await db.query<T>(sql, params);
  return res.rows[0] ?? null;
}

export async function one<T extends pg.QueryResultRow>(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const row = await maybeOne<T>(db, sql, params);
  if (!row) throw new Error('Consulta esperava uma linha, mas nenhuma foi retornada');
  return row;
}
