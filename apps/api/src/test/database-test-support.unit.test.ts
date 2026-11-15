import assert from "node:assert/strict";
import { test } from "node:test";

test("rejects_database_tests_and_cleanup_without_explicit_test_url", async () => {
  const originalTestUrl = process.env.TEST_DATABASE_URL;
  delete process.env.TEST_DATABASE_URL;
  const { getTestDatabasePool, resetProductInventoryTables } = await import("./database-test-support.js");
  const { createDatabasePool } = await import("../infrastructure/database.js");
  const pool = createDatabasePool("");
  try {
    assert.throws(() => getTestDatabasePool(), /TEST_DATABASE_URL/);
    await assert.rejects(resetProductInventoryTables(pool), /TEST_DATABASE_URL/);
  } finally {
    await pool.end();
    if (originalTestUrl === undefined) {
      delete process.env.TEST_DATABASE_URL;
    } else {
      process.env.TEST_DATABASE_URL = originalTestUrl;
    }
  }
});
