# Vercel + Supabase MVP — Design

## Intent

Move the current technical foundation to Vercel for the React PWA and Supabase for authentication, PostgreSQL persistence, row-level access policies, and server-side operations. The first deliverable is a safe, deployable foundation for the future PDV modules; it does not create sales, payments, inventory movements, Nuvemshop integration, or production credentials.

## Goals

- Keep the existing React, TypeScript, Vite, Tailwind, shadcn/ui, and Lucide stack.
- Deploy the web application on Vercel with build and environment-variable documentation that exposes only the Supabase URL and anonymous key.
- Introduce a Supabase migration baseline for authenticated single-tenant use, immutable audit records, and server-owned timestamps.
- Make the browser distinguish configuration, local/offline state, pending synchronization, and confirmed server state.
- Preserve the project's planned domain boundaries so product, inventory, sale, cash, and synchronization modules can be added incrementally.

## Non-goals

- No real sale, payment, stock adjustment, expense, cancellation, Nuvemshop webhook, or external synchronization implementation.
- No service-role key, database URL, or other secret in the PWA bundle.
- No claim that a local IndexedDB operation is server-confirmed.
- No change to the selected hosting architecture during this MVP.

## Constraints

- Vercel hosts the static React PWA.
- Supabase provides Auth, PostgreSQL, RLS, SQL migrations, and later RPC/Edge Functions for sensitive operations.
- All public client access uses the Supabase anonymous key and RLS; privileged server credentials stay only in Supabase-managed server execution.
- Money remains represented in integer cents and financial/inventory books remain append-only.
- Offline operations retain operation ID, aggregate ID, device ID, sequence, dependencies, and optional reversal reference; confirmation remains separate from commercial state.
- The project stays dependency-light; no new runtime library is added unless it is required for the Supabase browser client.

## Chosen approach

Replace the planned standalone Fastify/Render production API with Supabase's managed Postgres and controlled database interfaces. The web app talks directly to read models permitted by RLS, while future mutation endpoints are PostgreSQL RPCs or Supabase Edge Functions. This fits the selected Vercel + Supabase deployment without exposing privileged credentials.

## Data ownership and security

Each future business record belongs to the authenticated organization context. RLS is enabled by default, public access is denied unless a policy explicitly allows it, and the browser cannot update ledgers or materialized balances directly. Mutations that change balances will later run inside a server-owned SQL transaction that creates the immutable movement and updates the corresponding balance together.

## Delivery slices

1. Replace deployment documentation and Vite environment typing for Vercel/Supabase public configuration.
2. Add Supabase SQL baseline and tests for the static configuration boundary.
3. Add a small web configuration/synchronization status surface that never implies confirmation without a server response.
4. Build Products and Inventory as the first business slice in a later plan.

## Acceptance criteria

- A Vercel deployment builds the PWA with only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` exposed to the client.
- The repository has a repeatable Supabase migration baseline with RLS enabled and no permissive catch-all policy.
- The visible application state distinguishes local setup, pending sync, and confirmed sync.
- Typecheck, lint, and relevant tests pass.
