import { randomBytes } from 'node:crypto';
import { many, maybeOne, one } from '../../db/pool.js';
import { errors } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { exchangeAuthorizationCode } from './client.js';
import { PROVIDER, activeApi, getConnection, hasAppCredentials, markConnection } from './deps.js';
import type { NuvemshopDeps } from './deps.js';
import { SUBSCRIBED_EVENTS } from './events.js';

/** URL de instalação/autorização (a loja confirma no painel da Nuvemshop; `state` é de uso único). */
export async function createInstallUrl(
  deps: NuvemshopDeps,
  userId: string,
): Promise<{ url: string }> {
  if (!hasAppCredentials(deps.env)) {
    throw errors.conflict(
      'APP_CREDENTIALS_MISSING',
      'NUVEMSHOP_APP_ID/NUVEMSHOP_CLIENT_SECRET não configurados',
    );
  }
  const state = randomBytes(24).toString('hex');
  await deps.pool.query(
    `insert into integration_oauth_states (state, user_id, expires_at) values ($1, $2, now() + interval '10 minutes')`,
    [state, userId],
  );
  const base = deps.env.NUVEMSHOP_AUTH_BASE.replace(/\/$/, '');
  return { url: `${base}/apps/${deps.env.NUVEMSHOP_APP_ID}/authorize?state=${state}` };
}

/** Callback OAuth: valida o state, troca o code e guarda o token CIFRADO. Nunca registra o token. */
export async function completeAuthorization(
  deps: NuvemshopDeps,
  args: { code: string; state: string },
  exchange: typeof exchangeAuthorizationCode = exchangeAuthorizationCode,
): Promise<{ storeId: string }> {
  if (!hasAppCredentials(deps.env))
    throw errors.conflict('APP_CREDENTIALS_MISSING', 'Credenciais do aplicativo não configuradas');
  const st = await maybeOne<{ user_id: string }>(
    deps.pool,
    `update integration_oauth_states set used_at = now() where state = $1 and used_at is null and expires_at > now() returning user_id`,
    [args.state],
  );
  if (!st) throw errors.validation('state OAuth inválido, expirado ou já utilizado');
  const tok = await exchange({
    authBase: deps.env.NUVEMSHOP_AUTH_BASE,
    appId: deps.env.NUVEMSHOP_APP_ID!,
    clientSecret: deps.env.NUVEMSHOP_CLIENT_SECRET!,
    code: args.code,
    userAgent: deps.env.NUVEMSHOP_USER_AGENT,
  });
  const existing = await getConnection(deps.pool);
  if (existing && existing.external_store_id !== tok.storeId && existing.status === 'ativa') {
    throw errors.conflict(
      'STORE_MISMATCH',
      'Já existe conexão ativa com outra loja; desconecte antes',
    );
  }
  await deps.pool.query(
    `insert into integration_connections (provider, external_store_id, access_token_enc, scope, status, connected_by, connected_at)
     values ($1, $2, $3, $4, 'ativa', $5, now())
     on conflict (provider) do update set external_store_id = excluded.external_store_id, access_token_enc = excluded.access_token_enc,
       scope = excluded.scope, status = 'ativa', connected_by = excluded.connected_by, revoked_at = null, last_error = null,
       connected_at = case when integration_connections.external_store_id = excluded.external_store_id then integration_connections.connected_at else now() end,
       updated_at = now()`,
    [PROVIDER, tok.storeId, deps.cipher.encrypt(tok.accessToken), tok.scope, st.user_id],
  );
  await recordAudit(deps.pool, {
    actorId: st.user_id,
    action: 'integration.connect',
    entity: 'integration_connection',
    entityId: PROVIDER,
    payload: { storeId: tok.storeId, scope: tok.scope },
  });
  return { storeId: tok.storeId };
}

export async function disconnect(deps: NuvemshopDeps, actorId: string): Promise<void> {
  const conn = await getConnection(deps.pool);
  if (!conn) throw errors.notFound('Conexão');
  await deps.pool.query(
    `update integration_connections set access_token_enc = null, updated_at = now() where provider = $1`,
    [PROVIDER],
  );
  await markConnection(deps, 'desconectada', null);
  await deps.pool.query(
    `update integration_outbox set status = 'cancelado', note = 'integração desconectada' where status in ('pendente', 'falha')`,
  );
  await recordAudit(deps.pool, {
    actorId,
    action: 'integration.disconnect',
    entity: 'integration_connection',
    entityId: PROVIDER,
  });
}

/** Registro de webhooks: ação EXPLÍCITA do admin (altera a loja); não duplica os já existentes. */
export async function registerWebhooks(
  deps: NuvemshopDeps,
  actorId: string,
): Promise<{ created: string[]; existing: string[] }> {
  const ctx = await activeApi(deps);
  if (!ctx) throw errors.conflict('INTEGRATION_NOT_ACTIVE', 'Integração sem conexão ativa');
  if (!deps.env.PUBLIC_API_URL)
    throw errors.conflict('PUBLIC_API_URL_MISSING', 'PUBLIC_API_URL não configurada');
  const url = `${deps.env.PUBLIC_API_URL.replace(/\/$/, '')}/integrations/nuvemshop/webhooks`;
  const current = await ctx.api.listWebhooks();
  const created: string[] = [];
  const existing: string[] = [];
  for (const ev of SUBSCRIBED_EVENTS) {
    if (current.some((w) => w.event === ev && w.url === url)) existing.push(ev);
    else {
      await ctx.api.createWebhook(ev, url);
      created.push(ev);
    }
  }
  await recordAudit(deps.pool, {
    actorId,
    action: 'integration.webhooks_register',
    entity: 'integration_connection',
    entityId: PROVIDER,
    payload: { created, existing, url },
  });
  return { created, existing };
}

export async function setRestockOnCancel(
  deps: NuvemshopDeps,
  actorId: string,
  value: boolean,
): Promise<void> {
  await deps.pool.query(
    'update integration_connections set restock_on_cancel = $2, updated_at = now() where provider = $1',
    [PROVIDER, value],
  );
  await recordAudit(deps.pool, {
    actorId,
    action: 'integration.restock_on_cancel',
    entity: 'integration_connection',
    entityId: PROVIDER,
    payload: { value },
  });
}

const n = (rows: { n: string }[]) => (rows[0] ? Number(rows[0].n) : 0);

/** Estado e diagnóstico operacional (nunca inclui token). */
export async function getStatus(deps: NuvemshopDeps) {
  const conn = await getConnection(deps.pool);
  const q = <T extends { n: string }>(sql: string) => many<T>(deps.pool, sql);
  const [linked, outboxPending, outboxFailed, eventsPending, eventsFailed, issuesOpen, unlinked] =
    await Promise.all([
      q(`select count(*) as n from external_variant_links where status = 'ativo'`),
      q(`select count(*) as n from integration_outbox where status in ('pendente', 'enviando')`),
      q(`select count(*) as n from integration_outbox where status in ('falha', 'conflito')`),
      q(`select count(*) as n from integration_events where status in ('pendente', 'processando')`),
      q(`select count(*) as n from integration_events where status = 'falha'`),
      q(`select count(*) as n from integration_issues where status = 'aberto'`),
      q(
        `select count(*) as n from product_variants v where v.active and not exists (select 1 from external_variant_links l where l.local_variant_id = v.id and l.status = 'ativo')`,
      ),
    ]);
  const oldest = await maybeOne<{ at: Date | null }>(
    deps.pool,
    `select min(created_at) as at from integration_outbox where status in ('pendente', 'enviando')`,
  );
  return {
    appConfigured: hasAppCredentials(deps.env),
    webhookUrl: deps.env.PUBLIC_API_URL
      ? `${deps.env.PUBLIC_API_URL.replace(/\/$/, '')}/integrations/nuvemshop/webhooks`
      : null,
    connection: conn
      ? {
          status: conn.status,
          storeId: conn.external_store_id,
          scope: conn.scope,
          connectedAt: conn.connected_at,
          revokedAt: conn.revoked_at,
          lastEventAt: conn.last_event_at,
          lastStockConfirmedAt: conn.last_outbox_ok_at,
          lastReconcileAt: conn.last_reconcile_at,
          lastError: conn.last_error,
          restockOnCancel: conn.restock_on_cancel,
          rateLimitRemaining: conn.rate_limit_remaining,
        }
      : null,
    counts: {
      linkedVariants: n(linked),
      unlinkedVariants: n(unlinked),
      outboxPending: n(outboxPending),
      outboxFailed: n(outboxFailed),
      eventsPending: n(eventsPending),
      eventsFailed: n(eventsFailed),
      openIssues: n(issuesOpen),
    },
    oldestPendingStockAt: oldest?.at ?? null,
    /** Só é "em dia" quando nada está pendente e a última confirmação externa existe. */
    stockInSync: n(outboxPending) === 0 && n(outboxFailed) === 0 && !!conn?.last_outbox_ok_at,
  };
}

export { one };
