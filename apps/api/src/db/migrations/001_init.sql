-- 001_init: usuários, auditoria, catálogo e estoque (movimentações imutáveis)

create function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% é imutável: % não permitido', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end $$;

-- ---------- Usuários ----------
create table users (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) >= 2),
  email text not null,
  password_hash text not null,
  role text not null check (role in ('admin', 'gerente', 'vendedor')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_uq on users (lower(email));
create trigger users_updated_at before update on users
  for each row execute function set_updated_at();

-- ---------- Auditoria (append-only) ----------
create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid references users (id),
  action text not null,
  entity text not null,
  entity_id text,
  payload jsonb not null default '{}'::jsonb
);
create index audit_log_entity_idx on audit_log (entity, entity_id);
create index audit_log_at_idx on audit_log (at desc);
create trigger audit_log_immutable before update or delete on audit_log
  for each row execute function forbid_mutation();

-- ---------- Catálogo ----------
create table categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) >= 2),
  created_at timestamptz not null default now()
);
create unique index categories_name_uq on categories (lower(name));

create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) >= 2),
  description text,
  category_id uuid references categories (id) on delete restrict,
  active boolean not null default true,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_category_idx on products (category_id);
create index products_name_idx on products (lower(name));
create trigger products_updated_at before update on products
  for each row execute function set_updated_at();

create table product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id) on delete restrict,
  sku text not null check (length(trim(sku)) >= 1),
  barcode text,
  size text,
  color text,
  price_cents integer not null check (price_cents >= 0),
  cost_cents integer not null default 0 check (cost_cents >= 0),
  min_stock integer not null default 0 check (min_stock >= 0),
  active boolean not null default true,
  -- clock_timestamp: preserva a ordem de inserção das variantes dentro de uma transação
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default now()
);
create unique index product_variants_sku_uq on product_variants (lower(sku));
create unique index product_variants_barcode_uq on product_variants (barcode)
  where barcode is not null;
create index product_variants_product_idx on product_variants (product_id);
create trigger product_variants_updated_at before update on product_variants
  for each row execute function set_updated_at();

-- ---------- Estoque ----------
create table stock_batches (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references product_variants (id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_cost_cents integer not null default 0 check (unit_cost_cents >= 0),
  note text,
  received_at timestamptz not null default now(),
  created_by uuid references users (id),
  created_at timestamptz not null default now()
);
create index stock_batches_variant_idx on stock_batches (variant_id);
create trigger stock_batches_immutable before update or delete on stock_batches
  for each row execute function forbid_mutation();

create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references product_variants (id) on delete restrict,
  type text not null check (type in ('entrada', 'ajuste', 'venda', 'devolucao', 'estorno')),
  quantity_delta integer not null check (quantity_delta <> 0),
  reason text,
  batch_id uuid references stock_batches (id) on delete restrict,
  reverses_movement_id uuid unique references stock_movements (id) on delete restrict,
  idempotency_key text unique,
  actor_id uuid references users (id),
  created_at timestamptz not null default now(),
  -- sinal coerente com o tipo
  constraint stock_movements_sign_ck check (
    (type in ('entrada', 'devolucao') and quantity_delta > 0)
    or (type = 'venda' and quantity_delta < 0)
    or type in ('ajuste', 'estorno')
  ),
  -- estorno referencia o movimento original; os demais não
  constraint stock_movements_reversal_ck check (
    (type = 'estorno') = (reverses_movement_id is not null)
  )
);
create index stock_movements_variant_idx on stock_movements (variant_id, created_at desc);
create index stock_movements_created_idx on stock_movements (created_at desc);

create trigger stock_movements_immutable before update or delete on stock_movements
  for each row execute function forbid_mutation();

-- Um estorno deve anular exatamente o movimento original (mesma variante, delta oposto).
create function check_stock_reversal() returns trigger language plpgsql as $$
declare
  original stock_movements%rowtype;
begin
  if new.reverses_movement_id is null then
    return new;
  end if;
  select * into original from stock_movements where id = new.reverses_movement_id;
  if not found
     or original.variant_id <> new.variant_id
     or original.quantity_delta <> -new.quantity_delta
     or original.type = 'estorno' then
    raise exception 'estorno inválido para o movimento %', new.reverses_movement_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger stock_movements_check_reversal before insert on stock_movements
  for each row execute function check_stock_reversal();

-- Saldo por variante: derivado das movimentações, nunca escrito diretamente.
create table stock_levels (
  variant_id uuid primary key references product_variants (id) on delete restrict,
  quantity integer not null default 0,
  updated_at timestamptz not null default now()
);

-- Só triggers (profundidade >= 2) podem alterar o saldo.
create function guard_stock_levels() returns trigger language plpgsql as $$
begin
  if pg_trigger_depth() < 2 then
    raise exception 'stock_levels é derivado de stock_movements e não pode ser alterado diretamente'
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;
create trigger stock_levels_guard before insert or update or delete on stock_levels
  for each row execute function guard_stock_levels();

create function apply_stock_movement() returns trigger language plpgsql as $$
begin
  insert into stock_levels (variant_id, quantity)
  values (new.variant_id, new.quantity_delta)
  on conflict (variant_id)
  do update set quantity = stock_levels.quantity + excluded.quantity, updated_at = now();
  return new;
end $$;
create trigger stock_movements_apply after insert on stock_movements
  for each row execute function apply_stock_movement();

create function init_stock_level() returns trigger language plpgsql as $$
begin
  insert into stock_levels (variant_id, quantity) values (new.id, 0)
  on conflict (variant_id) do nothing;
  return new;
end $$;
create trigger product_variants_init_level after insert on product_variants
  for each row execute function init_stock_level();
