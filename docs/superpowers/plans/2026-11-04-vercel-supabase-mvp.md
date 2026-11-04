# Vercel + Supabase MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Render/Fastify deployment foundation with a Vercel-deployed React PWA and a secure Supabase-ready database and client configuration boundary.

**Architecture:** Vercel serves the Vite PWA. Supabase becomes the managed PostgreSQL/Auth backend; browser code reads only public Vite configuration and future sensitive mutations run in Supabase RPCs or Edge Functions. A minimal status model keeps local, pending, and server-confirmed synchronization distinct.

**Tech Stack:** React, TypeScript strict mode, Vite, Tailwind CSS, Supabase SQL migrations/RLS, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-vercel-supabase-mvp-design.md`

## Global Constraints

- Vercel hosts the static React PWA.
- Supabase provides Auth, PostgreSQL, RLS, SQL migrations, and later RPC/Edge Functions for sensitive operations.
- Public client configuration is limited to `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`; no service-role key or database URL enters the bundle.
- Values of money remain integer cents; financial and inventory books stay append-only.
- Local, pending, and confirmed synchronization states are visibly distinct; local completion is never server confirmation.
- No sale, payment, stock adjustment, Nuvemshop integration, or real credential is introduced in this slice.

## Review Focus

- Missing or malformed public Supabase configuration must produce a recoverable configuration state, not a fake connected state.
- A locally saved operation must not render as confirmed without an explicit server confirmation.
- The migration must enable RLS on every application table and must not add an `USING (true)` policy.
- Browser code must not read server-only names such as `SUPABASE_SERVICE_ROLE_KEY` or `DATABASE_URL`.
- A Vercel production refresh on a client-side route must resolve to the PWA entrypoint.

---

### Task 1: Establish Vercel and Supabase configuration boundaries

**Files:**
- Modify: `.env.example`
- Create: `apps/web/src/lib/supabase/config.ts`
- Create: `apps/web/src/lib/supabase/config.test.ts`
- Modify: `apps/web/src/vite-env.d.ts`
- Modify: `apps/web/package.json`
- Modify: `package.json`
- Modify: `docs/ARQUITETURA.md`
- Create: `vercel.json`

**Interfaces:**
- Produces: `readSupabasePublicConfig(environment: Record<string, string | undefined>): SupabasePublicConfigResult`.
- Produces: `SupabasePublicConfigResult = { status: "ready"; url: string; anonKey: string } | { status: "missing_configuration" }`.

- [ ] **Step 1: Write the failing configuration tests**

```ts
expect(readSupabasePublicConfig({
  VITE_SUPABASE_URL: "https://example.supabase.co",
  VITE_SUPABASE_ANON_KEY: "anon-key",
})).toEqual({ status: "ready", url: "https://example.supabase.co", anonKey: "anon-key" });

expect(readSupabasePublicConfig({ VITE_SUPABASE_URL: " " }))
  .toEqual({ status: "missing_configuration" });
```

- [ ] **Step 2: Run the test to verify it fails because the module does not exist**

Run: `npm run test --workspace=@lh-company/web -- config.test.ts`

Expected: FAIL with module-not-found error.

- [ ] **Step 3: Add Vitest and implement `readSupabasePublicConfig`**

Configure a workspace test script and implement trimmed, non-empty validation only for the two public Vite variables. Declare the two variables in `vite-env.d.ts`; keep server-only keys out of browser types.

- [ ] **Step 4: Add Vercel configuration and deployment documentation**

Create the SPA rewrite in `vercel.json`, replace old Render/database variables in `.env.example`, and update `docs/ARQUITETURA.md` to record Vercel + Supabase and the Vitest decision.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm run test --workspace=@lh-company/web -- config.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .env.example vercel.json docs/ARQUITETURA.md package.json package-lock.json apps/web
git commit -m "chore: configure Vercel and Supabase boundary"
```

### Task 2: Add a secure Supabase database baseline

**Files:**
- Create: `supabase/migrations/20261104120000_initial_foundation.sql`
- Create: `supabase/tests/initial_foundation.test.ts`
- Modify: `docs/ARQUITETURA.md`

**Interfaces:**
- Produces: Supabase migration creating organization membership context, immutable audit-event table, and an authenticated-member helper used by RLS policies.
- Produces: SQL policy invariant: no application table is accessible without authenticated organization membership.

- [ ] **Step 1: Write failing migration-invariant tests**

```ts
expect(migrationSql).toMatch(/ALTER TABLE public\.organization ENABLE ROW LEVEL SECURITY/);
expect(migrationSql).not.toMatch(/USING\s*\(\s*true\s*\)/i);
expect(migrationSql).toMatch(/CREATE TABLE public\.audit_event/);
```

- [ ] **Step 2: Run the test to verify it fails because the migration does not exist**

Run: `npm run test --workspace=@lh-company/web -- initial_foundation.test.ts`

Expected: FAIL with missing-file error.

- [ ] **Step 3: Add the SQL migration**

Create `organization`, `organization_member`, and append-only `audit_event` tables; enable and force RLS; permit authenticated members only to read their organization context and insert their own audit event with server timestamp. Do not permit `UPDATE` or `DELETE` on `audit_event`.

- [ ] **Step 4: Document the migration ownership model**

Record that later inventory and financial tables are organization-scoped, append-only by default, and mutation transactions belong in Supabase RPCs or Edge Functions rather than browser code.

- [ ] **Step 5: Run focused tests**

Run: `npm run test --workspace=@lh-company/web -- initial_foundation.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase docs/ARQUITETURA.md apps/web/package.json package-lock.json
git commit -m "feat: add Supabase security foundation"
```

### Task 3: Make synchronization configuration state visible in the PWA

**Files:**
- Create: `apps/web/src/features/sincronizacao/sync-status.ts`
- Create: `apps/web/src/features/sincronizacao/sync-status.test.ts`
- Create: `apps/web/src/features/sincronizacao/SyncStatusCard.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `SupabasePublicConfigResult` from Task 1.
- Produces: `deriveSyncStatus(config: SupabasePublicConfigResult): SyncStatus` where status is `configuration_required` or `ready_to_connect`; neither status represents server confirmation.

- [ ] **Step 1: Write the failing status tests**

```ts
expect(deriveSyncStatus({ status: "missing_configuration" })).toEqual({
  kind: "configuration_required",
  label: "Configuração pendente",
});
expect(deriveSyncStatus({ status: "ready", url: "https://example.supabase.co", anonKey: "key" }))
  .toEqual({ kind: "ready_to_connect", label: "Pronto para conectar" });
```

- [ ] **Step 2: Run the test to verify it fails because the function does not exist**

Run: `npm run test --workspace=@lh-company/web -- sync-status.test.ts`

Expected: FAIL with module-not-found error.

- [ ] **Step 3: Implement `deriveSyncStatus` and `SyncStatusCard`**

Use existing semantic Tailwind tokens and clear Portuguese text. Do not render credentials, URLs, or a confirmed state; state explicitly that no operation has been confirmed yet.

- [ ] **Step 4: Wire the card into the application shell**

Read `import.meta.env` through Task 1's pure configuration boundary and display the derived state in `App`.

- [ ] **Step 5: Run focused and full verification**

Run: `npm run test --workspace=@lh-company/web`

Expected: PASS.

Run: `npm run lint`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run build --workspace=@lh-company/web`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web package-lock.json
git commit -m "feat: show Supabase synchronization readiness"
```

## Self-review

- The plan covers the selected hosting/provider architecture, public configuration boundary, database baseline, RLS, immutable audit foundation, and visible synchronization distinction.
- Product, inventory, sales, financial transactions, Nuvemshop integration, and permanent server workflows are deliberately excluded and require separate plans.
- Task interfaces are internally consistent: Task 1 owns configuration, Task 2 owns database policy baseline, and Task 3 consumes the Task 1 result without adding network mutation behavior.
- Each Review Focus item is covered by Task 1, 2, or 3 tests or configuration verification.
