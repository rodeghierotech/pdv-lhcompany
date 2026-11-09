import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../migrations/20261106100000_catalog_inventory_operations.sql",
  import.meta.url,
);

describe("catalog and inventory migration", () => {
  it("keeps catalog and stock data organization-scoped and protected by RLS", async () => {
    const migration = await readFile(fileURLToPath(migrationUrl), "utf8");

    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.create_catalog_product/);
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.record_inventory_replenishment/);
    expect(migration).toMatch(/INSERT INTO public\.stock_lot/);
    expect(migration).toMatch(/INSERT INTO public\.inventory_movement/);
    expect(migration).toMatch(/INSERT INTO public\.audit_event/);
    expect(migration).toMatch(/CREATE TABLE public\.catalog_manual_operation/);
    expect(migration).toMatch(/pg_advisory_xact_lock/);
    expect(migration).toMatch(/ON CONFLICT \(variant_id\) DO UPDATE/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.record_inventory_replenishment/);
  });
});
