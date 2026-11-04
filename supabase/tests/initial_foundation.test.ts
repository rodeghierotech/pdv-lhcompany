import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../migrations/20261104120000_initial_foundation.sql",
  import.meta.url,
);

describe("initial Supabase foundation migration", () => {
  it("does not ship a permissive policy when RLS is enabled", async () => {
    const migrationSql = await readFile(fileURLToPath(migrationUrl), "utf8");

    expect(migrationSql).toMatch(
      /ALTER TABLE public\.organization ENABLE ROW LEVEL SECURITY/,
    );
    expect(migrationSql).toMatch(
      /ALTER TABLE public\.organization_member ENABLE ROW LEVEL SECURITY/,
    );
    expect(migrationSql).toMatch(
      /ALTER TABLE public\.audit_event ENABLE ROW LEVEL SECURITY/,
    );
    expect(migrationSql).not.toMatch(/USING\s*\(\s*true\s*\)/i);
  });

  it("assigns the audit timestamp in the database instead of trusting inserts", async () => {
    const migrationSql = await readFile(fileURLToPath(migrationUrl), "utf8");

    expect(migrationSql).toMatch(
      /CREATE FUNCTION public\.assign_audit_event_occurred_at\(\)/,
    );
    expect(migrationSql).toMatch(/NEW\.occurred_at := NOW\(\)/);
    expect(migrationSql).toMatch(
      /CREATE TRIGGER assign_audit_event_occurred_at[\s\S]*BEFORE INSERT ON public\.audit_event/,
    );
  });
});
