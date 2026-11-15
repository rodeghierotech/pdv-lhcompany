import { Pool, type PoolClient } from "pg";

let pool: Pool | undefined;

export function createDatabasePool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 10 });
}

export function getDatabasePool(): Pool {
  if (pool) {
    return pool;
  }

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL deve ser configurada para acessar o banco.");
  }

  pool = createDatabasePool(connectionString);
  return pool;
}

export async function withinTransaction<T>(
  operation: (client: PoolClient) => Promise<T>,
  database: Pool = getDatabasePool(),
): Promise<T> {
  const client = await database.connect();

  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
