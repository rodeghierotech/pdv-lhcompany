import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../migrations/20261106090000_catalog_inventory.sql",
  import.meta.url,
);

describe("catalog and inventory migration", () => {
  it("keeps catalog and stock data organization-scoped and protected by RLS", async () => {
    const migration = await readFile(fileURLToPath(migrationUrl), "utf8");

    expect(migration).toMatch(/CREATE TABLE public\.product/);
    expect(migration).toMatch(/organization_id UUID NOT NULL/);
    expect(migration).toMatch(/ALTER TABLE public\.product FORCE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/ALTER TABLE public\.inventory_movement FORCE ROW LEVEL SECURITY/);
    expect(migration).not.toMatch(/USING\s*\(\s*true\s*\)/i);
  });
});
