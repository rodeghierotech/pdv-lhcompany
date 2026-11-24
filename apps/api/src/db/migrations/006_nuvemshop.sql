-- Fase 9: integração Nuvemshop (módulo opcional; o núcleo não depende destas tabelas,
-- exceto pelo trigger de outbox, que pode ser removido sem afetar vendas/estoque).

-- Tipos de movimento gerados por pedidos online (baixa após pagamento / reposição por cancelamento).
alter table stock_movements drop constraint stock_movements_type_check;
alter table stock_movements add constraint stock_movements_type_check
  check (type in ('entrada', 'ajuste', 'venda', 'devolucao', 'estorno', 'pedido_online', 'estorno_pedido_online'));
alter table stock_movements drop constraint stock_movements_sign_ck;
alter table stock_movements add constraint stock_movements_sign_ck check (
  (type in ('entrada', 'devolucao', 'estorno_pedido_online') and quantity_delta > 0)
  or (type in ('venda', 'pedido_online') and quantity_delta < 0)
  or type in ('ajuste', 'estorno')
);

-- Conexão com a loja. O token é guardado CIFRADO (AES-256-GCM); nunca em claro nem em logs.
create table integration_connections (
  provider text primary key check (provider in ('nuvemshop')),
  external_store_id text not null,
  access_token_enc text,                         -- null = sem credencial (revogada/desconectada)
  scope text,
  status text not null check (status in ('ativa', 'revogada', 'autorizacao_invalida', 'desconectada')),
  restock_on_cancel boolean not null default true,
  connected_by uuid references users (id),
  connected_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_event_at timestamptz,
  last_outbox_ok_at timestamptz,
  last_reconcile_at timestamptz,
  orders_cursor timestamptz,                     -- varredura de pedidos perdidos (reconciliação)
  last_error text,
  rate_limit_remaining integer,
  rate_limit_seen_at timestamptz,
  updated_at timestamptz not null default now()
);

-- `state` do OAuth: uso único, expira.
create table integration_oauth_states (
  state text primary key,
  user_id uuid not null references users (id),
  expires_at timestamptz not null,
  used_at timestamptz
);

-- Catálogo remoto (cópia somente leitura, para sugerir vínculos). Nunca é fonte de verdade.
create table external_catalog_cache (
  provider text not null,
  external_product_id text not null,
  external_variant_id text not null,
  sku text,
  barcode text,
  name text not null,
  price_cents integer,
  stock integer,                                  -- null = estoque ilimitado/não gerenciado
  fetched_at timestamptz not null default now(),
  primary key (provider, external_variant_id)
);
create index external_catalog_sku_idx on external_catalog_cache (provider, lower(sku));

-- Vínculo variante local <-> variante Nuvemshop pelos IDENTIFICADORES externos (SKU só sugere).
create table external_variant_links (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  local_variant_id uuid not null references product_variants (id) on delete restrict,
  external_product_id text not null,
  external_variant_id text not null,
  external_sku text,
  status text not null default 'ativo' check (status in ('ativo', 'desvinculado', 'removido_remoto')),
  remote_stock_ack integer,                       -- último estoque remoto confirmado por nós
  remote_stock_seen integer,                      -- último estoque remoto observado
  remote_seen_at timestamptz,
  divergence_streak integer not null default 0,
  sending_since timestamptz,                      -- lease do envio (evita envios concorrentes)
  linked_by uuid references users (id),
  linked_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index external_links_local_uq on external_variant_links (provider, local_variant_id) where status = 'ativo';
create unique index external_links_remote_uq on external_variant_links (provider, external_variant_id) where status = 'ativo';

-- Caixa de entrada de webhooks/eventos (deduplicada e reprocessável).
create table integration_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  source text not null default 'webhook' check (source in ('webhook', 'reconcile', 'manual')),
  external_store_id text not null,
  event text not null,
  entity_id text,
  dedupe_key text not null,
  payload jsonb not null,
  status text not null default 'pendente' check (status in ('pendente', 'processando', 'processado', 'falha', 'ignorado')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
-- Reentregas idênticas enquanto o evento ainda não foi processado viram uma só linha.
create unique index integration_events_dedupe_uq on integration_events (dedupe_key) where status in ('pendente', 'processando');
create index integration_events_due_idx on integration_events (next_attempt_at) where status in ('pendente', 'falha');

-- Pedidos online (instantâneo mínimo, sem dados pessoais do comprador).
create table online_orders (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_order_id text not null,
  external_number text,
  status text not null,                           -- open | closed | cancelled
  payment_status text not null,
  total_cents integer,
  paid_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  remote_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, external_order_id)
);
create table online_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references online_orders (id) on delete cascade,
  external_item_key text not null,                -- product_id:variant_id:posição
  external_product_id text not null,
  external_variant_id text not null,
  sku text,
  quantity integer not null check (quantity > 0),
  local_variant_id uuid references product_variants (id),
  stock_status text not null default 'pendente'
    check (stock_status in ('pendente', 'baixado', 'sem_estoque', 'nao_mapeado', 'devolvido', 'nao_aplicavel')),
  deduct_movement_id uuid references stock_movements (id),
  restock_movement_id uuid references stock_movements (id),
  unique (order_id, external_item_key)
);

-- Pendências/conflitos que exigem decisão humana.
create table integration_issues (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  kind text not null check (kind in ('sem_estoque', 'item_nao_mapeado', 'estoque_divergente', 'reembolso_revisar', 'pedido_editado', 'estoque_remoto_insuficiente', 'multiplas_locations')),
  dedupe_key text not null,
  title text not null,
  details jsonb not null default '{}',
  status text not null default 'aberto' check (status in ('aberto', 'resolvido')),
  online_order_id uuid references online_orders (id),
  link_id uuid references external_variant_links (id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references users (id),
  resolution text,
  resolution_note text
);
create unique index integration_issues_open_uq on integration_issues (dedupe_key) where status = 'aberto';
create index integration_issues_status_idx on integration_issues (status, created_at desc);

-- Outbox transacional: cada movimento de estoque local de uma variante vinculada gera uma linha
-- NA MESMA TRANSAÇÃO (trigger abaixo). Envio assíncrono pelo worker.
create table integration_outbox (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  link_id uuid not null references external_variant_links (id),
  variant_id uuid not null references product_variants (id),
  delta integer not null check (delta <> 0),
  movement_id uuid not null unique references stock_movements (id),
  status text not null default 'pendente' check (status in ('pendente', 'enviando', 'enviado', 'falha', 'conflito', 'cancelado')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  note text
);
create index integration_outbox_due_idx on integration_outbox (link_id, next_attempt_at) where status = 'pendente';
create index integration_outbox_status_idx on integration_outbox (status, created_at desc);

create function enqueue_nuvemshop_stock() returns trigger language plpgsql as $$
begin
  -- Movimentos originados pela própria integração (pedido online / reconciliação) não voltam ao canal.
  if new.type in ('pedido_online', 'estorno_pedido_online')
     or coalesce(new.idempotency_key, '') like 'nuvemshop:%' then
    return new;
  end if;
  insert into integration_outbox (provider, link_id, variant_id, delta, movement_id)
  select l.provider, l.id, new.variant_id, new.quantity_delta, new.id
  from external_variant_links l
  join integration_connections c on c.provider = l.provider and c.status <> 'desconectada'
  where l.provider = 'nuvemshop' and l.local_variant_id = new.variant_id and l.status = 'ativo';
  return new;
end $$;
create trigger stock_movements_nuvemshop_outbox after insert on stock_movements
  for each row execute function enqueue_nuvemshop_stock();
