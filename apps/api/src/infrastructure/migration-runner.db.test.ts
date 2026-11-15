import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { test } from "node:test";

test("applies_product_operation_and_low_stock_columns_once", async () => {
  assert.ok(process.env.TEST_DATABASE_URL?.trim(), "TEST_DATABASE_URL deve ser configurada para executar testes PostgreSQL; nenhum banco de produção será usado.");
  const { runMigrations } = await import("./migration-runner.js");
  const { withinTransaction } = await import("./database.js");
  const { getTestDatabasePool, resetProductInventoryTables } = await import("../test/database-test-support.js");
  const pool = getTestDatabasePool();
  let migrated = false;

  try {
    await runMigrations(pool);
    await runMigrations(pool);
    migrated = true;
    await resetProductInventoryTables(pool);

    const columns = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND (table_name, column_name) IN (
          ('product', 'operation_id'),
          ('product', 'operation_fingerprint'),
          ('inventory_movement', 'operation_fingerprint'),
          ('product_variant', 'minimum_stock_quantity')
        )
    `);
    assert.equal(columns.rowCount, 4);
    for (const [table, column, type] of [
      ["product", "operation_id", "uuid"],
      ["product", "operation_fingerprint", "text"],
      ["inventory_movement", "operation_fingerprint", "text"],
    ]) {
      const actual = columns.rows.find((row) => row.table_name === table && row.column_name === column);
      assert.equal(actual?.data_type, type);
      assert.equal(actual?.is_nullable, "YES");
    }
    const minimumStock = columns.rows.find((row) => row.column_name === "minimum_stock_quantity");
    assert.equal(minimumStock?.data_type, "integer");
    assert.equal(minimumStock?.is_nullable, "NO");
    assert.equal(minimumStock?.column_default, "3");

    const migrationFiles = (await readdir(new URL("../../migrations/", import.meta.url)))
      .filter((name) => name.endsWith(".sql")).sort();
    const migrations = await pool.query<{ name: string; count: string }>(
      "SELECT name, COUNT(*)::TEXT AS count FROM schema_migration GROUP BY name ORDER BY name",
    );
    assert.deepEqual(migrations.rows, migrationFiles.map((name) => ({ name, count: "1" })));

    const productId = randomUUID();
    const variantId = randomUUID();
    const operationId = randomUUID();
    await withinTransaction(async (client) => {
      await client.query("INSERT INTO product (id, name, operation_id) VALUES ($1, 'Migration test', $2)", [productId, operationId]);
      await client.query(`
        INSERT INTO product_variant (id, product_id, sku, sale_price_in_cents, cost_in_cents)
        VALUES ($1, $2, 'MIGRATION-TEST', 100, 50)
      `, [variantId, productId]);
    }, pool);
    const variant = await pool.query<{ minimum_stock_quantity: number }>(
      "SELECT minimum_stock_quantity FROM product_variant WHERE id = $1", [variantId],
    );
    assert.equal(variant.rows[0]?.minimum_stock_quantity, 3);
    await assert.rejects(pool.query("UPDATE product_variant SET minimum_stock_quantity = -1 WHERE id = $1", [variantId]), { code: "23514" });
    await assert.rejects(pool.query("UPDATE product_variant SET minimum_stock_quantity = NULL WHERE id = $1", [variantId]), { code: "23502" });
    await assert.rejects(pool.query("INSERT INTO product (id, name, operation_id) VALUES ($1, 'Duplicate', $2)", [randomUUID(), operationId]), { code: "23505" });

    const rolledBackId = randomUUID();
    const operationError = new Error("Abort the test transaction");
    await assert.rejects(withinTransaction(async (client) => {
      await client.query("INSERT INTO product (id, name) VALUES ($1, 'Rollback test')", [rolledBackId]);
      throw operationError;
    }, pool), (error) => error === operationError);
    const rolledBack = await pool.query("SELECT id FROM product WHERE id = $1", [rolledBackId]);
    assert.equal(rolledBack.rowCount, 0);
  } finally {
    try {
      // The pool belongs exclusively to the explicitly configured test database.
      if (migrated) {
        await resetProductInventoryTables(pool);
      }
    } finally {
      await pool.end();
    }
  }
});
