import { getDatabasePool } from "./database.js";
import { runMigrations } from "./migration-runner.js";

const pool = getDatabasePool();
try {
  await runMigrations(pool);
} finally {
  await pool.end();
}
