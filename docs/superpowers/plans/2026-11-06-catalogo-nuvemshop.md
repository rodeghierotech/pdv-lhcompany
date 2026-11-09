# Catálogo Nuvemshop + Manual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar um catálogo canônico de produtos/variantes com importação inicial segura da Nuvemshop, cadastro manual complementar e reposição auditável.

**Architecture:** O Supabase guarda catálogo, mappings externos, lote, livro de estoque e saldo materializado, todos vinculados à organização e protegidos por RLS. O PWA apenas lê dados autorizados e chama RPCs; a Edge Function de importação guarda o segredo Nuvemshop e usa os mesmos comandos idempotentes do cadastro manual.

**Tech Stack:** React, TypeScript, Zod, Supabase PostgreSQL/RPC/Edge Functions, Vitest, Tailwind, Lucide.

**Spec:** `docs/superpowers/specs/2026-11-05-catalogo-nuvemshop-design.md`

## Global Constraints

- Importação inicial e cadastro manual alimentam o mesmo catálogo canônico.
- Tokens Nuvemshop, service-role e URL de banco nunca entram no PWA.
- Movimentos de estoque são imutáveis; saldo materializado e movimento são gravados na mesma transação.
- Reimportação ou saldo local existente vira pendência, sem sobrescrita automática.
- A importação lê somente o local padrão configurado; custo ausente importa `0` marcado para revisão.
- Estado local/pendente nunca é mostrado como confirmado pelo servidor.

## Review Focus

- Reexecução da mesma importação não duplica movimento nem saldo — Task 2.
- SKU duplicado/ambíguo nunca é religado automaticamente — Task 2.
- Usuário de outra organização não lê nem escreve catálogo — Task 1.
- Estoque importado com saldo local existente só abre pendência — Task 2.
- Formulário manual preserva valores quando a RPC devolve erro recuperável — Task 3.

---

### Task 1: Modelo Supabase e contratos de catálogo

**Files:**
- Create: `supabase/migrations/20261106090000_catalog_inventory.sql`
- Create: `supabase/tests/catalog_inventory.test.ts`
- Modify: `packages/contracts/src/products.ts`
- Create: `packages/contracts/src/catalog-import.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `docs/ARQUITETURA.md`

**Interfaces:**
- Produces `CreateCatalogProductInputSchema`, `RecordStockReplenishmentInputSchema`, and `CatalogImportCandidateSchema`.
- Produces organization-scoped product, variant, mapping, import, lot, movement, balance, and pending-review tables.

- [ ] Write failing contract tests for cents, nonempty SKU, quantity greater than zero, and missing-cost review flag.
- [ ] Run the focused test and confirm failure because schemas/migration are absent.
- [ ] Implement schemas and migration with forced RLS, no client policy for ledger/balance writes, and RPC entry points only for authenticated members.
- [ ] Add migration-invariant tests for organization scope, forced RLS, immutable movement, and no permissive policy.
- [ ] Run contract and migration tests; run typecheck.
- [ ] Commit: `feat: add catalog and inventory foundation`.

### Task 2: Idempotent import normalization and server command layer

**Files:**
- Create: `packages/domain/src/catalog-import.ts`
- Create: `packages/domain/src/catalog-import.test.ts`
- Create: `supabase/functions/import-nuvemshop/index.ts`
- Create: `supabase/functions/_shared/nuvemshop-client.ts`
- Create: `supabase/functions/_shared/catalog-command.ts`
- Modify: `docs/ARQUITETURA.md`

**Interfaces:**
- Consumes `CatalogImportCandidate` from Task 1.
- Produces `normalizeNuvemshopVariant(raw): CatalogImportCandidate` and command results `imported | linked | needs_review`.

- [ ] Write failing tests for unique SKU linking, ambiguous SKU pending review, existing local balance pending review, default-location extraction, missing cost, and repeated operation ID.
- [ ] Run the test and confirm missing normalizer/command behavior.
- [ ] Implement the pure Nuvemshop normalizer, Zod boundary validation, and Edge Function that reads protected secrets only server-side.
- [ ] Implement SQL/RPC command transaction that writes product, variant, mapping, import, movement and balance atomically; replays return the original outcome.
- [ ] Run domain tests and migration tests; verify no token appears in browser source.
- [ ] Commit: `feat: add idempotent Nuvemshop catalog import`.

### Task 3: Cadastro manual e reposição auditável

**Files:**
- Create: `apps/web/src/features/produtos/product-form.ts`
- Create: `apps/web/src/features/produtos/product-form.test.ts`
- Create: `apps/web/src/features/estoque/replenishment-form.ts`
- Create: `apps/web/src/features/estoque/replenishment-form.test.ts`
- Create: `apps/web/src/features/produtos/ProductDialog.tsx`
- Create: `apps/web/src/features/estoque/ReplenishmentDialog.tsx`
- Create: `apps/web/src/lib/catalog/catalog-api.ts`

**Interfaces:**
- Consumes Task 1 schemas and Task 2 server command response states.
- Produces form states that preserve user input on recoverable failure and distinguish server confirmation from pending request.

- [ ] Write failing reducer/validator tests for a product with variants and for positive replenishment quantity/cost.
- [ ] Run focused tests and confirm missing behavior.
- [ ] Implement form state and Supabase RPC adapter; never issue direct table writes from the browser.
- [ ] Implement accessible dialogs using shared shell and semantic tokens, with confirmations before financial/stock mutation.
- [ ] Run frontend tests, lint, typecheck, and production build.
- [ ] Commit: `feat: add manual catalog and replenishment flows`.

### Task 4: Catálogo, importação e pendências na interface

**Files:**
- Create: `apps/web/src/features/produtos/CatalogPage.tsx`
- Create: `apps/web/src/features/produtos/ImportStatusCard.tsx`
- Create: `apps/web/src/features/produtos/PendingReviewList.tsx`
- Create: `apps/web/src/features/produtos/catalog-view-model.ts`
- Create: `apps/web/src/features/produtos/catalog-view-model.test.ts`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes catalog/import command states from Tasks 1–3.
- Produces readable confirmed catalog rows and explicit import/pending-review states.

- [ ] Write failing view-model tests for confirmed catalog, import-in-progress, recoverable failure, and needs-review states.
- [ ] Run focused tests and confirm missing view model.
- [ ] Implement catalog list/search, import confirmation action, manual product/replenishment entry points, and pending-review list without rendering sensitive details.
- [ ] Wire into `App` while keeping synchronization readiness separate from commercial confirmation.
- [ ] Run the full test suite, lint, all workspace typechecks, and Vite build.
- [ ] Commit: `feat: add catalog import and review workspace`.

## Self-review

- Tasks 1–4 cover schema, secure server import, manual fallback, stock ledger, pending review, and visible confirmation state.
- Publishing to Nuvemshop, orders/webhooks, sales/payments, and continuous synchronization remain out of scope.
- Task 2 owns import identity; Tasks 3–4 consume its explicit command states.
- Each Review Focus item is assigned to a test in its owning task.
