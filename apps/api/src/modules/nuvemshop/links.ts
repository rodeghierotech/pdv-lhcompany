import { many, maybeOne, one } from '../../db/pool.js';
import { errors } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { PROVIDER, activeApi, isMultiLocation } from './deps.js';
import type { NuvemshopDeps } from './deps.js';

/** Copia (somente leitura) o catálogo remoto para sugerir vínculos. Nada é gravado na loja. */
export async function importCatalog(deps: NuvemshopDeps): Promise<{ variants: number }> {
  const ctx = await activeApi(deps);
  if (!ctx) throw errors.conflict('INTEGRATION_NOT_ACTIVE', 'Integração sem conexão ativa');
  let total = 0;
  for (let page = 1; page <= 200; page++) {
    const { items, hasMore } = await ctx.api.listProducts(page);
    for (const p of items) {
      for (const v of p.variants) {
        await deps.pool.query(
          `insert into external_catalog_cache (provider, external_product_id, external_variant_id, sku, barcode, name, price_cents, stock)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (provider, external_variant_id) do update
             set external_product_id = excluded.external_product_id, sku = excluded.sku, barcode = excluded.barcode,
                 name = excluded.name, price_cents = excluded.price_cents, stock = excluded.stock, fetched_at = now()`,
          [PROVIDER, p.id, v.id, v.sku, v.barcode, p.name, v.priceCents, v.stock],
        );
        total++;
      }
    }
    if (!hasMore) break;
  }
  return { variants: total };
}

export interface LinkOverviewRow {
  variantId: string;
  sku: string;
  productName: string;
  localStock: number;
  link: {
    id: string;
    externalProductId: string;
    externalVariantId: string;
    remoteStockSeen: number | null;
    status: string;
  } | null;
  suggestion: {
    externalProductId: string;
    externalVariantId: string;
    name: string;
    sku: string | null;
    stock: number | null;
  } | null;
}

export async function listLinkOverview(
  deps: NuvemshopDeps,
  filter: 'todos' | 'vinculados' | 'nao_vinculados',
  q: string | undefined,
): Promise<LinkOverviewRow[]> {
  const rows = await many<{
    variant_id: string;
    sku: string;
    product_name: string;
    local_stock: number;
    link_id: string | null;
    ext_product: string | null;
    ext_variant: string | null;
    seen: number | null;
    link_status: string | null;
    s_product: string | null;
    s_variant: string | null;
    s_name: string | null;
    s_sku: string | null;
    s_stock: number | null;
  }>(
    deps.pool,
    `select v.id as variant_id, v.sku, p.name as product_name, coalesce(sl.quantity, 0) as local_stock,
            l.id as link_id, l.external_product_id as ext_product, l.external_variant_id as ext_variant,
            l.remote_stock_seen as seen, l.status as link_status,
            c.external_product_id as s_product, c.external_variant_id as s_variant, c.name as s_name, c.sku as s_sku, c.stock as s_stock
     from product_variants v
     join products p on p.id = v.product_id
     left join stock_levels sl on sl.variant_id = v.id
     left join external_variant_links l on l.local_variant_id = v.id and l.provider = $1 and l.status = 'ativo'
     left join lateral (
        select * from external_catalog_cache cc
        where cc.provider = $1 and l.id is null and lower(cc.sku) = lower(v.sku)
          and not exists (select 1 from external_variant_links x where x.provider = $1 and x.external_variant_id = cc.external_variant_id and x.status = 'ativo')
        limit 1) c on true
     where v.active and ($2::text is null or v.sku ilike '%' || $2 || '%' or p.name ilike '%' || $2 || '%')
       and ($3 = 'todos' or ($3 = 'vinculados' and l.id is not null) or ($3 = 'nao_vinculados' and l.id is null))
     order by p.name, v.sku limit 300`,
    [PROVIDER, q ?? null, filter],
  );
  return rows.map((r) => ({
    variantId: r.variant_id,
    sku: r.sku,
    productName: r.product_name,
    localStock: r.local_stock,
    link: r.link_id
      ? {
          id: r.link_id,
          externalProductId: r.ext_product!,
          externalVariantId: r.ext_variant!,
          remoteStockSeen: r.seen,
          status: r.link_status!,
        }
      : null,
    suggestion: r.s_variant
      ? {
          externalProductId: r.s_product!,
          externalVariantId: r.s_variant,
          name: r.s_name!,
          sku: r.s_sku,
          stock: r.s_stock,
        }
      : null,
  }));
}

/**
 * Vincula pelos IDs externos (o SKU só sugere). Lê o estoque remoto como linha de base: a
 * diferença para o estoque local NÃO é sobrescrita; a reconciliação a expõe como pendência.
 */
export async function createLink(
  deps: NuvemshopDeps,
  actorId: string,
  input: { variantId: string; externalVariantId: string },
) {
  const ctx = await activeApi(deps);
  if (!ctx) throw errors.conflict('INTEGRATION_NOT_ACTIVE', 'Integração sem conexão ativa');
  const cached = await maybeOne<{ external_product_id: string; sku: string | null }>(
    deps.pool,
    'select external_product_id, sku from external_catalog_cache where provider = $1 and external_variant_id = $2',
    [PROVIDER, input.externalVariantId],
  );
  if (!cached)
    throw errors.unprocessable(
      'REMOTE_VARIANT_UNKNOWN',
      'Variante remota desconhecida: importe o catálogo primeiro',
    );
  const local = await maybeOne<{ stock: number }>(
    deps.pool,
    'select coalesce(sl.quantity, 0) as stock from product_variants v left join stock_levels sl on sl.variant_id = v.id where v.id = $1',
    [input.variantId],
  );
  if (!local) throw errors.notFound('Variante local');
  const remote = await ctx.api.getVariant(cached.external_product_id, input.externalVariantId);
  if (!remote)
    throw errors.unprocessable('REMOTE_VARIANT_GONE', 'A variante não existe mais na Nuvemshop');
  if (await isMultiLocation(ctx, remote.locationCount)) {
    throw errors.unprocessable(
      'MULTIPLE_LOCATIONS',
      'Variante com múltiplas locations não é suportada nesta versão',
    );
  }
  const link = await one<{ id: string }>(
    deps.pool,
    `insert into external_variant_links (provider, local_variant_id, external_product_id, external_variant_id, external_sku, remote_stock_ack, remote_stock_seen, remote_seen_at, linked_by)
     values ($1, $2, $3, $4, $5, $6, $6, now(), $7) returning id`,
    [
      PROVIDER,
      input.variantId,
      cached.external_product_id,
      input.externalVariantId,
      remote.sku,
      remote.stock,
      actorId,
    ],
  ).catch((err: unknown) => {
    if ((err as { code?: string }).code === '23505')
      throw errors.conflict('ALREADY_LINKED', 'Variante local ou remota já vinculada');
    throw err;
  });
  await recordAudit(deps.pool, {
    actorId,
    action: 'integration.link',
    entity: 'external_variant_link',
    entityId: link.id,
    payload: { variantId: input.variantId, externalVariantId: input.externalVariantId },
  });
  return {
    id: link.id,
    localStock: local.stock,
    remoteStock: remote.stock,
    divergence: remote.stock === null ? null : remote.stock - local.stock,
  };
}

export async function removeLink(
  deps: NuvemshopDeps,
  actorId: string,
  linkId: string,
): Promise<void> {
  const res = await deps.pool.query(
    `update external_variant_links set status = 'desvinculado', updated_at = now() where id = $1 and status = 'ativo' returning id`,
    [linkId],
  );
  if (!res.rowCount) throw errors.notFound('Vínculo');
  await deps.pool.query(
    `update integration_outbox set status = 'cancelado', note = 'vínculo removido' where link_id = $1 and status in ('pendente', 'falha', 'conflito')`,
    [linkId],
  );
  await recordAudit(deps.pool, {
    actorId,
    action: 'integration.unlink',
    entity: 'external_variant_link',
    entityId: linkId,
  });
}
