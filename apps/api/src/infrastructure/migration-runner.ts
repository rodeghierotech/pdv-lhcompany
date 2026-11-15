import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

import { withinTransaction } from "./database.js";

const defaultMigrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

export async function runMigrations(
  database: Pool,
  migrationsDirectory: string = defaultMigrationsDirectory,
): Promise<void> {
  await withinTransaction(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const appliedResult = await client.query<{ name: string }>(
      "SELECT name FROM schema_migration",
    );
    const applied = new Set(appliedResult.rows.map((migration) => migration.name));
    const migrationNames = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const migrationName of migrationNames) {
      if (applied.has(migrationName)) {
        continue;
      }

      const migrationSql = await readFile(join(migrationsDirectory, migrationName), "utf8");
      await client.query(migrationSql);
      await client.query("INSERT INTO schema_migration (name) VALUES ($1)", [migrationName]);
    }
  }, database);
}
