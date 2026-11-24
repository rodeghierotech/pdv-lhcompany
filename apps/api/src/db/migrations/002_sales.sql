-- 002_sales: clientes, limites de desconto, vendas, itens, pagamentos e devoluções.
-- Princípio: fatos financeiros são imutáveis; correções são novos registros (estorno/devolução).
-- Invariantes críticas são verificadas no COMMIT por constraint triggers, como última barreira
-- caso a camada de serviço tenha um defeito.

-- ---------- Limites de desconto por papel (configurável) ----------
create table role_discount_limits (
  role text primary key check (role in ('admin', 'gerente', 'vendedor')),
  max_discount_bp integer not null check (max_discount_bp between 0 and 10000), -- 10000 = 100%
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id)
);
create trigger role_discount_limits_updated_at before update on role_discount_limits
  for each row execute function set_updated_at();
-- Padrão inicial: apenas gerente e administrador podem dar desconto.
insert into role_discount_limits (role, max_discount_bp)
values ('admin', 10000), ('gerente', 10000), ('vendedor', 0);

-- ---------- Clientes ----------
create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) >= 2),
  document text,
  phone text,
  -- null = sem limite de crédito
  credit_limit_cents integer check (credit_limit_cents is null or credit_limit_cents >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index customers_document_uq on customers (document) where document is not null;
create index customers_name_idx on customers (lower(name));
create trigger customers_updated_at before update on customers
  for each row execute function set_updated_at();

-- ---------- Vendas ----------
create table sales (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  status text not null default 'concluida' check (status in ('concluida', 'cancelada', 'devolvida')),
  customer_id uuid references customers (id) on delete restrict,
  seller_id uuid not null references users (id),
  subtotal_cents integer not null check (subtotal_cents >= 0 and subtotal_cents <= 1000000000),
  discount_cents integer not null check (discount_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  note text,
  idempotency_key text not null unique,
  request_hash text not null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references users (id),
  cancel_reason text,
  cancel_key text unique,
  constraint sales_totals_ck check (
    discount_cents <= subtotal_cents and total_cents = subtotal_cents - discount_cents
  ),
  constraint sales_cancel_ck check (
    (status = 'cancelada' and cancelled_at is not null and cancelled_by is not null
       and cancel_reason is not null and cancel_key is not null)
    or (status <> 'cancelada' and cancelled_at is null and cancelled_by is null
       and cancel_reason is null and cancel_key is null)
  )
);
create index sales_created_idx on sales (created_at desc);
create index sales_customer_idx on sales (customer_id) where customer_id is not null;
create index sales_status_idx on sales (status);

-- Venda só muda de estado (concluida -> cancelada | devolvida); demais campos são imutáveis.
create function guard_sales_update() returns trigger language plpgsql as $$
begin
  if old.status <> 'concluida' then
    raise exception 'venda % está % (estado terminal) e não pode ser alterada', old.number, old.status
      using errcode = 'restrict_violation';
  end if;
  if (new.id, new.number, new.customer_id, new.seller_id, new.subtotal_cents, new.discount_cents,
      new.total_cents, new.note, new.idempotency_key, new.request_hash, new.created_at)
     is distinct from
     (old.id, old.number, old.customer_id, old.seller_id, old.subtotal_cents, old.discount_cents,
      old.total_cents, old.note, old.idempotency_key, old.request_hash, old.created_at) then
    raise exception 'campos da venda % são imutáveis', old.number using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger sales_guard before update on sales
  for each row execute function guard_sales_update();
create trigger sales_no_delete before delete on sales
  for each row execute function forbid_mutation();

create table sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales (id) on delete restrict,
  variant_id uuid not null references product_variants (id) on delete restrict,
  position integer not null check (position >= 0),
  -- snapshots: o histórico não muda se o cadastro for editado depois
  sku text not null,
  product_name text not null,
  size text,
  color text,
  quantity integer not null check (quantity between 1 and 1000),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  unit_cost_cents integer not null check (unit_cost_cents >= 0),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  line_total_cents integer not null check (line_total_cents >= 0),
  constraint sale_items_line_ck check (
    quantity::bigint * unit_price_cents <= 1000000000
    and discount_cents <= quantity * unit_price_cents
    and line_total_cents = quantity * unit_price_cents - discount_cents
  ),
  unique (sale_id, variant_id)
);
create index sale_items_variant_idx on sale_items (variant_id);
create trigger sale_items_immutable before update or delete on sale_items
  for each row execute function forbid_mutation();

-- ---------- Devoluções ----------
create table sale_returns (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales (id) on delete restrict,
  reason text not null check (length(trim(reason)) >= 3),
  idempotency_key text not null unique,
  request_hash text not null,
  created_by uuid references users (id),
  created_at timestamptz not null default clock_timestamp()
);
create index sale_returns_sale_idx on sale_returns (sale_id);
create trigger sale_returns_immutable before update or delete on sale_returns
  for each row execute function forbid_mutation();

create table sale_return_items (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references sale_returns (id) on delete restrict,
  sale_item_id uuid not null references sale_items (id) on delete restrict,
  quantity integer not null check (quantity > 0),
  amount_cents integer not null check (amount_cents >= 0),
  unique (return_id, sale_item_id)
);
create index sale_return_items_item_idx on sale_return_items (sale_item_id);
create trigger sale_return_items_immutable before update or delete on sale_return_items
  for each row execute function forbid_mutation();

-- ---------- Pagamentos (recebimentos e estornos) ----------
create table payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales (id) on delete restrict,
  kind text not null check (kind in ('recebimento', 'estorno')),
  method text not null check (method in ('dinheiro', 'pix', 'debito', 'credito')),
  amount_cents integer not null check (amount_cents > 0),
  -- estorno de cancelamento aponta o recebimento original; estorno de devolução aponta a devolução
  reverses_payment_id uuid unique references payments (id) on delete restrict,
  return_id uuid references sale_returns (id) on delete restrict,
  created_by uuid references users (id),
  -- clock_timestamp: mantém a ordem cronológica dos pagamentos dentro de uma mesma transação
  created_at timestamptz not null default clock_timestamp(),
  constraint payments_refs_ck check (
    (kind = 'estorno' or (reverses_payment_id is null and return_id is null))
    and (reverses_payment_id is null or return_id is null)
  )
);
create index payments_sale_idx on payments (sale_id);
create trigger payments_immutable before update or delete on payments
  for each row execute function forbid_mutation();

create function check_payment_reversal() returns trigger language plpgsql as $$
declare
  original payments%rowtype;
begin
  if new.reverses_payment_id is null then
    return new;
  end if;
  select * into original from payments where id = new.reverses_payment_id;
  if not found
     or original.kind <> 'recebimento'
     or original.sale_id <> new.sale_id
     or original.method <> new.method
     or original.amount_cents <> new.amount_cents then
    raise exception 'estorno de pagamento inválido para %', new.reverses_payment_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger payments_check_reversal before insert on payments
  for each row execute function check_payment_reversal();

-- ---------- Vínculo estoque <-> venda ----------
alter table stock_movements
  add column sale_item_id uuid references sale_items (id) on delete restrict,
  add column sale_return_item_id uuid references sale_return_items (id) on delete restrict;
-- Exatamente uma baixa por item vendido e uma entrada por item devolvido.
create unique index stock_movements_sale_item_uq on stock_movements (sale_item_id)
  where sale_item_id is not null;
create unique index stock_movements_return_item_uq on stock_movements (sale_return_item_id)
  where sale_return_item_id is not null;
alter table stock_movements add constraint stock_movements_sale_ref_ck check (
  (type = 'venda') = (sale_item_id is not null)
  and (type = 'devolucao') = (sale_return_item_id is not null)
);

-- ---------- Visões financeiras (derivadas; nada é duplicado/denormalizado) ----------
create view sale_summary as
select
  s.id as sale_id,
  s.status,
  s.total_cents,
  r.returned_cents,
  p.received_cents,
  -- quanto o cliente ainda deve (cancelada não deve nada)
  case when s.status = 'cancelada' then 0
       else greatest(s.total_cents - r.returned_cents - p.received_cents, 0) end as balance_cents,
  case when s.status = 'cancelada' then null
       when s.total_cents - r.returned_cents - p.received_cents <= 0 then 'pago'
       when p.received_cents <= 0 then 'fiado'
       else 'parcial' end as payment_status
from sales s
cross join lateral (
  select coalesce(sum(ri.amount_cents), 0)::integer as returned_cents
  from sale_return_items ri join sale_returns rt on rt.id = ri.return_id
  where rt.sale_id = s.id
) r
cross join lateral (
  select coalesce(sum(case pm.kind when 'recebimento' then pm.amount_cents else -pm.amount_cents end), 0)::integer
    as received_cents
  from payments pm where pm.sale_id = s.id
) p;

-- ---------- Integridade verificada no COMMIT ----------
create function check_sale_integrity(p_sale uuid) returns void language plpgsql as $$
declare
  s sales%rowtype;
  v_count integer;
  v_sub bigint;
  v_disc bigint;
  v_total bigint;
  v_returned bigint;
  v_received bigint;
  v_all_returned boolean;
begin
  -- Bloqueia a venda: serializa verificações concorrentes (cada instrução vê dados já confirmados).
  select * into s from sales where id = p_sale for update;
  if not found then
    return;
  end if;

  select count(*), coalesce(sum(quantity::bigint * unit_price_cents), 0),
         coalesce(sum(discount_cents), 0), coalesce(sum(line_total_cents), 0)
    into v_count, v_sub, v_disc, v_total
  from sale_items where sale_id = s.id;
  if v_count = 0 then
    raise exception 'sale_integrity: venda % sem itens', s.number using errcode = 'check_violation';
  end if;
  if s.subtotal_cents <> v_sub or s.discount_cents <> v_disc or s.total_cents <> v_total then
    raise exception 'sale_integrity: totais da venda % não conferem com os itens', s.number
      using errcode = 'check_violation';
  end if;

  -- Cada item vendido tem exatamente a baixa de estoque correspondente.
  if exists (
    select 1 from sale_items i
    where i.sale_id = s.id
      and not exists (
        select 1 from stock_movements m
        where m.sale_item_id = i.id and m.type = 'venda'
          and m.variant_id = i.variant_id and m.quantity_delta = -i.quantity)
  ) then
    raise exception 'sale_integrity: venda % com item sem baixa de estoque', s.number
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(ri.amount_cents), 0) into v_returned
  from sale_return_items ri join sale_returns r on r.id = ri.return_id
  where r.sale_id = s.id;

  select coalesce(sum(case kind when 'recebimento' then amount_cents else -amount_cents end), 0)
    into v_received
  from payments where sale_id = s.id;

  -- Devoluções: quantidades, valores e entradas de estoque consistentes por item.
  if exists (
    select 1 from sale_items i
    where i.sale_id = s.id and (
      (select coalesce(sum(quantity), 0) from sale_return_items where sale_item_id = i.id) > i.quantity
      or (select coalesce(sum(amount_cents), 0) from sale_return_items where sale_item_id = i.id) > i.line_total_cents
      or (
        (select coalesce(sum(quantity), 0) from sale_return_items where sale_item_id = i.id) = i.quantity
        and (select coalesce(sum(amount_cents), 0) from sale_return_items where sale_item_id = i.id) <> i.line_total_cents)
    )
  ) then
    raise exception 'sale_integrity: devolução inconsistente na venda %', s.number
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from sale_return_items ri
    join sale_returns r on r.id = ri.return_id
    join sale_items i on i.id = ri.sale_item_id
    where r.sale_id = s.id
      and not exists (
        select 1 from stock_movements m
        where m.sale_return_item_id = ri.id and m.type = 'devolucao'
          and m.variant_id = i.variant_id and m.quantity_delta = ri.quantity)
  ) then
    raise exception 'sale_integrity: devolução sem entrada de estoque na venda %', s.number
      using errcode = 'check_violation';
  end if;

  if s.status = 'cancelada' then
    if v_received <> 0 then
      raise exception 'sale_integrity: venda % cancelada com valores recebidos não estornados', s.number
        using errcode = 'check_violation';
    end if;
    if v_returned <> 0 then
      raise exception 'sale_integrity: venda % cancelada possui devoluções', s.number
        using errcode = 'check_violation';
    end if;
    if exists (
      select 1 from stock_movements m join sale_items i on i.id = m.sale_item_id
      where i.sale_id = s.id and m.type = 'venda'
        and not exists (select 1 from stock_movements e where e.reverses_movement_id = m.id)
    ) then
      raise exception 'sale_integrity: venda % cancelada sem estorno de estoque', s.number
        using errcode = 'check_violation';
    end if;
  else
    if v_received < 0 or v_received > s.total_cents - v_returned then
      raise exception 'sale_integrity: valor recebido da venda % fora do permitido', s.number
        using errcode = 'check_violation';
    end if;
    if exists (
      select 1 from stock_movements m join sale_items i on i.id = m.sale_item_id
      where i.sale_id = s.id and m.type = 'venda'
        and exists (select 1 from stock_movements e where e.reverses_movement_id = m.id)
    ) then
      raise exception 'sale_integrity: estoque da venda % estornado sem cancelamento', s.number
        using errcode = 'check_violation';
    end if;
    select not exists (
      select 1 from sale_items i
      where i.sale_id = s.id
        and i.quantity > (select coalesce(sum(quantity), 0) from sale_return_items where sale_item_id = i.id)
    ) into v_all_returned;
    if v_all_returned <> (s.status = 'devolvida') then
      raise exception 'sale_integrity: estado da venda % incoerente com as devoluções', s.number
        using errcode = 'check_violation';
    end if;
  end if;
end $$;

create function trg_check_sale_integrity() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'sales' then
    perform check_sale_integrity(new.id);
  elsif tg_table_name = 'sale_return_items' then
    perform check_sale_integrity((select sale_id from sale_returns where id = new.return_id));
  else
    perform check_sale_integrity(new.sale_id);
  end if;
  return null;
end $$;

create constraint trigger sales_integrity after insert or update on sales
  deferrable initially deferred for each row execute function trg_check_sale_integrity();
create constraint trigger sale_items_integrity after insert on sale_items
  deferrable initially deferred for each row execute function trg_check_sale_integrity();
create constraint trigger payments_integrity after insert on payments
  deferrable initially deferred for each row execute function trg_check_sale_integrity();
create constraint trigger sale_returns_integrity after insert on sale_returns
  deferrable initially deferred for each row execute function trg_check_sale_integrity();
create constraint trigger sale_return_items_integrity after insert on sale_return_items
  deferrable initially deferred for each row execute function trg_check_sale_integrity();
