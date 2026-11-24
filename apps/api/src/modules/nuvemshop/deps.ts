import type pg from 'pg';
import { many, maybeOne } from '../../db/pool.js';
import type { Db } from '../../db/pool.js';
import type { Env } from '../../config/env.js';
import type { CredentialCipher } from './crypto.js';
import { NuvemshopError } from './types.js';
import type { NuvemshopApi } from './types.js';

export const PROVIDER = 'nuvemshop';
export const MAX_ATTEMPTS = 8;

export interface NuvemshopDeps {
  pool: pg.Pool;
  env: Env;
  cipher: CredentialCipher;
  /** Fábrica do adaptador (injetável: testes usam um servidor falso). */
  makeApi: (ctx: { storeId: string; accessToken: string }) => NuvemshopApi;
  now?: () => Date;
  random?: () => number;
}

export const nowOf = (d: NuvemshopDeps): Date => (d.now ? d.now() : new Date());

/** Espera exponencial com jitter: 30 s · 2^(tentativa-1), teto de 1 h (±25 %). */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
  return Math.round(base * (0.75 + random() * 0.5));
}

export interface ConnectionRow {
  provider: string;
  external_store_id: string;
  access_token_enc: string | null;
  scope: string | null;
  status: 'ativa' | 'revogada' | 'autorizacao_invalida' | 'desconectada';
  restock_on_cancel: boolean;
  connected_at: Date;
  revoked_at: Date | null;
  last_event_at: Date | null;
  last_outbox_ok_at: Date | null;
  last_reconcile_at: Date | null;
  orders_cursor: Date | null;
  last_error: string | null;
  rate_limit_remaining: number | null;
  rate_limit_seen_at: Date | null;
}

export const getConnection = (db: Db): Promise<ConnectionRow | null> =>
  maybeOne<ConnectionRow>(db, 'select * from integration_connections where provider = $1', [
    PROVIDER,
  ]);

export function hasAppCredentials(env: Env): boolean {
  return !!env.NUVEMSHOP_APP_ID && !!env.NUVEMSHOP_CLIENT_SECRET;
}

/** Adaptador pronto para uso, ou null quando não há conexão ativa com credencial. */
export async function activeApi(
  deps: NuvemshopDeps,
  db: Db = deps.pool,
): Promise<{ conn: ConnectionRow; api: NuvemshopApi } | null> {
  const conn = await getConnection(db);
  if (!conn || conn.status !== 'ativa' || !conn.access_token_enc) return null;
  let token: string;
  try {
    token = deps.cipher.decrypt(conn.access_token_enc);
  } catch {
    await markConnection(
      deps,
      'autorizacao_invalida',
      'credencial ilegível (chave de cifragem alterada?)',
    );
    return null;
  }
  return { conn, api: deps.makeApi({ storeId: conn.external_store_id, accessToken: token }) };
}

export async function markConnection(
  deps: NuvemshopDeps,
  status: ConnectionRow['status'],
  error: string | null,
): Promise<void> {
  await deps.pool.query(
    `update integration_connections
     set status = $2, last_error = $3, updated_at = now(),
         revoked_at = case when $2 in ('revogada', 'autorizacao_invalida') then now() else revoked_at end
     where provider = $1`,
    [PROVIDER, status, error],
  );
}

/** 401/403 invalidam a conexão (token revogado/desinstalado); o worker para até nova autorização. */
export async function handleAuthFailure(deps: NuvemshopDeps, err: unknown): Promise<boolean> {
  if (err instanceof NuvemshopError && err.kind === 'auth') {
    await markConnection(deps, 'autorizacao_invalida', err.message);
    return true;
  }
  return false;
}

export async function recordRateLimit(
  deps: NuvemshopDeps,
  info: { remaining: number | null },
): Promise<void> {
  if (info.remaining === null) return;
  await deps.pool.query(
    'update integration_connections set rate_limit_remaining = $2, rate_limit_seen_at = now() where provider = $1',
    [PROVIDER, info.remaining],
  );
}

export async function openIssue(
  tx: Db,
  args: {
    kind: string;
    dedupeKey: string;
    title: string;
    details?: Record<string, unknown>;
    orderId?: string;
    linkId?: string;
  },
): Promise<void> {
  await tx.query(
    `insert into integration_issues (provider, kind, dedupe_key, title, details, online_order_id, link_id)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (dedupe_key) where status = 'aberto' do nothing`,
    [
      PROVIDER,
      args.kind,
      args.dedupeKey,
      args.title,
      JSON.stringify(args.details ?? {}),
      args.orderId ?? null,
      args.linkId ?? null,
    ],
  );
}

export async function autoResolveIssues(
  tx: Db,
  dedupeLike: string,
  resolution: string,
): Promise<void> {
  await tx.query(
    `update integration_issues set status = 'resolvido', resolved_at = now(), resolution = 'auto', resolution_note = $2
     where status = 'aberto' and dedupe_key like $1`,
    [dedupeLike, resolution],
  );
}

export const countBy = <T extends { n: string }>(rows: T[]) =>
  rows.map((r) => ({ ...r, n: Number(r.n) }));
export { many };

export type ApiCtx = NonNullable<Awaited<ReturnType<typeof activeApi>>>;

const locationMemo = new WeakMap<object, Promise<number | null>>();
/**
 * Nº de locations da LOJA (cache por ciclo). Complementa `inventory_levels` da variante: com mais de
 * uma location o endpoint de estoque não documenta qual delas recebe o ajuste → bloqueio seguro.
 * Retorna null se a loja não informa (então vale só a checagem por variante).
 */
export function storeLocationCount(ctx: ApiCtx): Promise<number | null> {
  let p = locationMemo.get(ctx);
  if (!p) {
    p = ctx.api.listLocations().then(
      (l) => l.length,
      (err) => {
        if (err instanceof NuvemshopError && err.kind === 'not_found') return null;
        throw err;
      },
    );
    locationMemo.set(ctx, p);
  }
  return p;
}

export async function isMultiLocation(ctx: ApiCtx, variantLocations: number): Promise<boolean> {
  if (variantLocations > 1) return true;
  return ((await storeLocationCount(ctx)) ?? 0) > 1;
}
