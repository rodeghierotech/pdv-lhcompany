# Supabase + Vercel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adaptar o monorepo para Supabase PostgreSQL + Vercel Hobby, preservando o domínio e substituindo o worker persistente por ciclos acionados pelo Supabase Cron.

**Architecture:** A PWA e a API serão dois projetos Vercel do mesmo monorepo. A API Fastify usa Supavisor transaction mode com um pool pequeno, enquanto migrations usam conexão direta; o Supabase Cron chama uma rota interna autenticada que executa um único `runCycle()` da Nuvemshop.

**Tech Stack:** TypeScript 5, Fastify 5, React/Vite, PostgreSQL 16, Supabase Postgres/Supavisor/Vault/pg_cron/pg_net, Vercel Functions.

**Spec:** `docs/superpowers/specs/2026-11-24-supabase-vercel-design.md`

## Global Constraints

- Preservar fatos financeiros e de estoque append-only e todas as migrations existentes.
- Não migrar para Supabase Auth, Data API no frontend ou Edge Functions.
- `DATABASE_URL` usa o transaction pooler em produção; `DATABASE_URL_MIGRATIONS` usa conexão direta.
- Nenhum segredo, URL com credencial ou identificador real de projeto será versionado.
- O primeiro ambiente remoto usa Vercel Hobby e um único Supabase; previews não recebem credenciais de produção.
- Testes de integridade usam exclusivamente um PostgreSQL descartável e nunca um banco remoto com dados.
- A pasta atual não contém `.git`; passos de commit só serão executados se os metadados Git forem restaurados antes da execução.

## Review Focus

- `DATABASE_POOL_MAX` ausente, inválido ou excessivo não pode quebrar desenvolvimento nem multiplicar conexões serverless silenciosamente.
- A rota de cron deve rejeitar segredo ausente, formato incorreto e valor diferente sem executar trabalho.
- A detecção da Vercel deve encontrar apenas o entrypoint Fastify correto, sem escolher o atual `src/app.ts` por engano.
- A migration de Supabase deve passar em PostgreSQL local sem os papéis `anon`/`authenticated` e ainda habilitar RLS em todas as tabelas do aplicativo.
- Deployments de preview não podem receber instruções que os conectem ao Supabase de produção.

---

### Task 1: Pool compatível com Supavisor e serverless

**Files:**
- Modify: `apps/api/src/config/env.ts`
- Modify: `apps/api/src/db/pool.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/worker.ts`
- Modify: `apps/api/src/scripts/create-admin.ts`
- Modify: `apps/api/src/scripts/migrate.ts`
- Create: `apps/api/test/pool.test.ts`

**Interfaces:**
- Produces: `createPool(connectionString, onError?, { max? })` e `Env.DATABASE_POOL_MAX`.
- Production callers pass the configured max; migration and administrative scripts keep explicit, bounded pools.

- [ ] **Step 1: Write failing unit tests** asserting that `createPool` exposes `options.max = 1` when configured, while defaults remain suitable for local/test execution; add env parsing cases for valid and invalid `DATABASE_POOL_MAX`. SSL remains mandatory in remote connection strings through `sslmode=require`.
- [ ] **Step 2: Run** `apps\api\node_modules\.bin\vitest.cmd run test/pool.test.ts` and confirm failures are caused by the missing options/schema field.
- [ ] **Step 3: Implement** pool options and `DATABASE_POOL_MAX` validation without adding a dependency; wire the value into runtime callers and keep migration on its dedicated URL.
- [ ] **Step 4: Run** the focused test, API typecheck and existing non-database unit tests; expect zero failures.
- [ ] **Step 5: Commit**, if Git exists: `feat(api): configure postgres pool for serverless`.

### Task 2: Entrypoint Fastify determinístico para Vercel

**Files:**
- Move: `apps/api/src/app.ts` → `apps/api/src/application.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/test/helpers.ts`
- Modify: `apps/api/test/nuvemshop.test.ts`
- Modify: `apps/api/tsup.config.ts`
- Create: `apps/api/test/deployment-entry.test.ts`

**Interfaces:**
- Preserves: `buildApp(options): Promise<FastifyInstance>` and `redactUrl()` exports.
- Produces: `src/server.ts` as the only Vercel-recognized Fastify filename in `apps/api/src`.

- [ ] **Step 1: Write a failing structural test** that enumerates Vercel-recognized entrypoint names and asserts only `src/server.ts` exists, while `buildApp` remains importable from `src/application.ts`.
- [ ] **Step 2: Run** the focused test and confirm it fails because `src/app.ts` still matches Vercel entrypoint detection.
- [ ] **Step 3: Rename** the builder module, update all imports and preserve local `listen`/shutdown behavior supported by Vercel's Fastify adapter.
- [ ] **Step 4: Run** the focused test, API typecheck and API build; expect success.
- [ ] **Step 5: Commit**, if Git exists: `refactor(api): make vercel fastify entry deterministic`.

### Task 3: Rota autenticada para um ciclo da Nuvemshop

**Files:**
- Modify: `apps/api/src/config/env.ts`
- Create: `apps/api/src/modules/nuvemshop/cron.ts`
- Modify: `apps/api/src/modules/nuvemshop/index.ts`
- Modify: `apps/api/src/application.ts`
- Create: `apps/api/test/cron.test.ts`

**Interfaces:**
- Produces: `registerNuvemshopCron(app, deps, secret, run?)` and `isAuthorizedCron(header, secret)`.
- Consumes: existing `runCycle(deps)`; optional injected runner is test-only dependency injection, not a mock of domain behavior.
- HTTP: `POST /internal/cron/nuvemshop`, `Authorization: Bearer <CRON_SECRET>`.

- [ ] **Step 1: Write failing tests** with a real in-memory Fastify instance for: route absent when secret is unset; 401 for missing/malformed/wrong auth; 200 and exactly one runner invocation for the right secret; runner failure returns a sanitized 503.
- [ ] **Step 2: Run** `apps\api\node_modules\.bin\vitest.cmd run test/cron.test.ts`; confirm each case fails because the module/route does not exist.
- [ ] **Step 3: Implement** constant-time secret comparison, conditional registration and one bounded `runCycle`; do not expose secrets or raw provider errors in the response, including on the sanitized 503 path.
- [ ] **Step 4: Run** focused tests, API typecheck and lint; expect success.
- [ ] **Step 5: Commit**, if Git exists: `feat(integrations): expose protected nuvemshop cycle`.

### Task 4: Proteção do schema para Supabase Data API

**Files:**
- Create: `apps/api/src/db/migrations/008_supabase_security.sql`
- Modify: `apps/api/test/db-integrity.test.ts`

**Interfaces:**
- Produces: RLS enabled on every application table present after migration 007.
- Behavior: conditional privilege revocation only when Supabase roles exist; local PostgreSQL remains supported.

- [ ] **Step 1: Provision an explicitly disposable PostgreSQL database** with a unique database name for this run; record the exact URL only in the process environment.
- [ ] **Step 2: Write a failing database test** that queries `pg_class`/`pg_namespace` and asserts every application table has `relrowsecurity = true`; also assert migrations complete when `anon` and `authenticated` do not exist.
- [ ] **Step 3: Run** the focused database test against the disposable URL and confirm it fails because migration 008 is absent.
- [ ] **Step 4: Implement** migration 008 with explicit table coverage and conditional `REVOKE` blocks; do not add permissive policies.
- [ ] **Step 5: Re-run** the focused test and the full API PostgreSQL suite; expect 238+ passing tests and no skipped suites.
- [ ] **Step 6: Commit**, if Git exists: `feat(db): protect public tables for supabase`.

### Task 5: Configuração dos dois projetos Vercel

**Files:**
- Create: `apps/api/vercel.json`
- Create: `apps/web/vercel.json`
- Create: `test/deployment-config.test.mjs`
- Delete: `render.yaml`
- Modify: `package.json`

**Interfaces:**
- API project root: `apps/api`, Fastify auto-detection, Node.js Function, no Vercel cron.
- Web project root: `apps/web`, Vite output `dist`, SPA rewrite to `/index.html`.

- [ ] **Step 1: Write a failing Node test** that parses both missing `vercel.json` files and asserts: valid JSON; API contains no `crons`; web has SPA rewrite; no `render.yaml`; root script exposes a deployment-config check.
- [ ] **Step 2: Run** the test and confirm failure on missing Vercel configs/present Render blueprint.
- [ ] **Step 3: Add** the minimal Vercel configs, remove the obsolete Render blueprint, and add only the script needed to rerun the structural test.
- [ ] **Step 4: Run** deployment-config test, API build, web build and typecheck; expect success.
- [ ] **Step 5: Commit**, if Git exists: `chore(deploy): target vercel projects`.

### Task 6: Roteiro operacional Supabase/Vercel e documentação viva

**Files:**
- Create: `docs/DEPLOY_SUPABASE_VERCEL.md`
- Modify: `.env.example`
- Modify: `docs/env.homologacao.example`
- Modify: `docs/HOMOLOGACAO_NUVEMSHOP.md`
- Modify: `docs/ARQUITETURA.md`
- Modify: `docs/DESIGN_SYSTEM.md` only if deployment-visible PWA behavior changes
- Modify: `PLANO.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Documents: two Vercel projects, environment scoping, Supavisor/direct URLs, migrations, Vault secrets, enabling `pg_cron`/`pg_net`, scheduling/unscheduling, CORS, rollback and smoke tests.
- Produces no real credentials and performs no external deployment.

- [ ] **Step 1: Add failing documentation assertions** to `test/deployment-config.test.mjs`: no operational `Neon`/`Render` references outside the historical design/plan records; required Supabase/Vercel headings and variables exist; examples contain placeholders only.
- [ ] **Step 2: Run** the structural test and confirm it fails on existing Neon/Render references.
- [ ] **Step 3: Write** the deployment guide, including exact dashboard steps and parameterized SQL templates for Vault + `pg_cron` + `pg_net`, plus an unschedule/secret-rotation procedure.
- [ ] **Step 4: Update** environment examples, architecture, plan and agent rules to the new target; mark deployment and real Supabase/Nuvemshop validation as pending.
- [ ] **Step 5: Run** the structural test, Prettier check and secret-pattern scan; expect success and no real URLs/keys.
- [ ] **Step 6: Commit**, if Git exists: `docs: document supabase and vercel operations`.

### Task 7: Final verification and handoff

**Files:**
- Modify only files required to fix failures caused by Tasks 1–6.

**Interfaces:**
- Verifies the complete deliverable; creates no cloud resources.

- [ ] **Step 1: Run** `pnpm check` with `DATABASE_URL_TEST` set to the disposable database; require typecheck, lint, format, all tests and builds to pass.
- [ ] **Step 2: Run** `pnpm e2e` against a migrated disposable database and test admin; require all existing browser flows to pass.
- [ ] **Step 3: Run** `node --test test/deployment-config.test.mjs` and a repository-wide scan for `Neon`, `Render`, plaintext credentials and production Supabase identifiers.
- [ ] **Step 4: Inspect** generated API/web artifacts and confirm no backend secret or database URL appears in `apps/web/dist`.
- [ ] **Step 5: Update** `PLANO.md` with exact fresh counts and explicitly retain remote deployment, Supabase Cron activation and real Nuvemshop homologation as pending.
- [ ] **Step 6: Commit**, if Git exists: `chore: verify supabase vercel migration`.
