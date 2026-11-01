import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getDatabasePool } from "./database.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = join(currentDirectory, "../../migrations");

async function runMigrations(): Promise<void> {
  const pool = getDatabasePool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
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

      const migrationSql = await readFile(
        join(migrationsDirectory, migrationName),
        "utf8",
      );

      await client.query(migrationSql);
      await client.query("INSERT INTO schema_migration (name) VALUES ($1)", [
        migrationName,
      ]);
      console.info(`Migração aplicada: ${migrationName}`);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

await runMigrations();
