import type { Pool } from "pg";

import { createDatabasePool } from "../infrastructure/database.js";

function requireTestDatabaseUrl(): string {
  const connectionString = process.env.TEST_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("TEST_DATABASE_URL deve ser configurada para executar testes PostgreSQL; nenhum banco de produção será usado.");
  }
  return connectionString;
}

export function getTestDatabasePool(): Pool {
  return createDatabasePool(requireTestDatabaseUrl());
}

export async function resetProductInventoryTables(pool: Pool): Promise<void> {
  const connectionString = requireTestDatabaseUrl();
  if (pool.options.connectionString !== connectionString) {
    throw new Error("A limpeza exige um pool criado com TEST_DATABASE_URL.");
  }
  await pool.query(`
    TRUNCATE inventory_balance, inventory_movement, stock_lot, product_variant, product
    RESTART IDENTITY CASCADE
  `);
}
