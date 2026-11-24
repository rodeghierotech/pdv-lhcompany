-- 003_cash: caixa (sessões e movimentos), recebimento posterior de fiado e vencimento.
-- Fonte única da verdade financeira: `payments`. O caixa NÃO copia pagamentos; ele só os
-- classifica (payments.cash_session_id) e acrescenta movimentos próprios (sangria, suprimento,
-- despesa). Fatos são imutáveis; correções são registros compensatórios.

-- ---------- Sessões de caixa ----------
create table cash_sessions (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  status text not null default 'aberto' check (status in ('aberto', 'fechado')),
  opened_by uuid not null references users (id),
  opened_at timestamptz not null default clock_timestamp(),
  opening_cents integer not null check (opening_cents >= 0 and opening_cents <= 1000000000),
  open_key text not null unique,
  closed_by uuid references users (id),
  closed_at timestamptz,
  counted_cents integer check (counted_cents >= 0),
  expected_cents integer,
  difference_cents integer,
  close_note text,
  close_key text unique,
  constraint cash_sessions_close_ck check (
    (status = 'aberto' and closed_by is null and closed_at is null and counted_cents is null
       and expected_cents is null and difference_cents is null and close_key is null)
    or (status = 'fechado' and closed_by is not null and closed_at is not null
       and counted_cents is not null and expected_cents is not null and close_key is not null
       and difference_cents = counted_cents - expected_cents
       and (difference_cents = 0 or length(trim(coalesce(close_note, ''))) >= 3))
  )
);
-- Um operador só pode ter um caixa aberto por vez.
create unique index cash_sessions_one_open_per_user on cash_sessions (opened_by)
  where status = 'aberto';
create index cash_sessions_opened_idx on cash_sessions (opened_at desc);

create function guard_cash_session_update() returns trigger language plpgsql as $$
begin
  if old.status <> 'aberto' then
    raise exception 'caixa % já está fechado e não pode ser alterado', old.number
      using errcode = 'restrict_violation';
  end if;
  if new.status <> 'fechado'
     or (new.id, new.number, new.opened_by, new.opened_at, new.opening_cents, new.open_key)
        is distinct from
        (old.id, old.number, old.opened_by, old.opened_at, old.opening_cents, old.open_key) then
    raise exception 'caixa %: só é permitido fechar', old.number using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger cash_sessions_guard before update on cash_sessions
  for each row execute function guard_cash_session_update();
create trigger cash_sessions_no_delete before delete on cash_sessions
  for each row execute function forbid_mutation();

-- Toda operação financeira exige um caixa ABERTO do próprio operador. O FOR SHARE serializa
-- contra o fechamento (que usa FOR UPDATE): nada entra num caixa que está sendo fechado.
create function assert_open_session(p_session uuid, p_user uuid) returns void
language plpgsql as $$
declare
  s cash_sessions%rowtype;
begin
  if p_session is null then
    raise exception 'cash_integrity: operação sem caixa aberto' using errcode = 'check_violation';
  end if;
  select * into s from cash_sessions where id = p_session for share;
  if not found or s.status <> 'aberto' then
    raise exception 'cash_integrity: caixa fechado ou inexistente' using errcode = 'check_violation';
  end if;
  if s.opened_by is distinct from p_user then
    raise exception 'cash_integrity: caixa pertence a outro operador' using errcode = 'check_violation';
  end if;
end $$;

-- ---------- Movimentos de caixa (sangria, suprimento, despesa e seus estornos) ----------
create table cash_movements (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references cash_sessions (id) on delete restrict,
  kind text not null check (kind in ('sangria', 'suprimento', 'despesa', 'estorno')),
  -- efeito na gaveta de dinheiro
  direction text not null check (direction in ('entrada', 'saida')),
  amount_cents integer not null check (amount_cents > 0 and amount_cents <= 1000000000),
  description text not null check (length(trim(description)) >= 3),
  category text,
  reverses_movement_id uuid unique references cash_movements (id) on delete restrict,
  idempotency_key text not null unique,
  request_hash text not null,
  created_by uuid not null references users (id),
  created_at timestamptz not null default clock_timestamp(),
  constraint cash_movements_reverse_ck check ((kind = 'estorno') = (reverses_movement_id is not null))
);
create index cash_movements_session_idx on cash_movements (session_id, created_at);
create trigger cash_movements_immutable before update or delete on cash_movements
  for each row execute function forbid_mutation();

create function check_cash_movement() returns trigger language plpgsql as $$
declare
  original cash_movements%rowtype;
begin
  perform assert_open_session(new.session_id, new.created_by);
  if new.kind = 'estorno' then
    select * into original from cash_movements where id = new.reverses_movement_id;
    if not found or original.kind = 'estorno' or original.amount_cents <> new.amount_cents
       or original.direction = new.direction then
      raise exception 'cash_integrity: estorno de movimento inválido' using errcode = 'check_violation';
    end if;
  elsif (new.kind = 'suprimento') <> (new.direction = 'entrada') then
    raise exception 'cash_integrity: sentido incompatível com o tipo' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger cash_movements_check before insert on cash_movements
  for each row execute function check_cash_movement();

-- ---------- Recebimentos posteriores (fiado / saldo de venda parcial) ----------
create table debt_receipts (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  kind text not null check (kind in ('recebimento', 'estorno')),
  customer_id uuid not null references customers (id) on delete restrict,
  cash_session_id uuid not null references cash_sessions (id) on delete restrict,
  total_cents integer not null check (total_cents > 0),
  reverses_receipt_id uuid unique references debt_receipts (id) on delete restrict,
  reason text,
  note text,
  idempotency_key text not null unique,
  request_hash text not null,
  created_by uuid not null references users (id),
  created_at timestamptz not null default clock_timestamp(),
  constraint debt_receipts_kind_ck check (
    (kind = 'estorno') = (reverses_receipt_id is not null)
    and (kind = 'recebimento' or length(trim(coalesce(reason, ''))) >= 3)
  )
);
create index debt_receipts_customer_idx on debt_receipts (customer_id, created_at desc);
create trigger debt_receipts_immutable before update or delete on debt_receipts
  for each row execute function forbid_mutation();
create function check_debt_receipt_insert() returns trigger language plpgsql as $$
begin
  perform assert_open_session(new.cash_session_id, new.created_by);
  return new;
end $$;
create trigger debt_receipts_check before insert on debt_receipts
  for each row execute function check_debt_receipt_insert();

-- ---------- Vínculos nas tabelas existentes ----------
alter table payments
  add column cash_session_id uuid references cash_sessions (id) on delete restrict,
  add column receipt_id uuid references debt_receipts (id) on delete restrict;
create index payments_session_idx on payments (cash_session_id) where cash_session_id is not null;
create index payments_receipt_idx on payments (receipt_id) where receipt_id is not null;

alter table sales
  add column cash_session_id uuid references cash_sessions (id) on delete restrict,
  add column cancel_session_id uuid references cash_sessions (id) on delete restrict,
  add column due_date date;
create index sales_session_idx on sales (cash_session_id) where cash_session_id is not null;
create index sales_due_idx on sales (due_date) where due_date is not null;

alter table sale_returns
  add column cash_session_id uuid references cash_sessions (id) on delete restrict;
create index sale_returns_session_idx on sale_returns (cash_session_id) where cash_session_id is not null;

-- Registros novos exigem caixa aberto do operador (registros anteriores à 003 ficam "sem caixa").
create function check_payment_cash() returns trigger language plpgsql as $$
begin
  perform assert_open_session(new.cash_session_id, new.created_by);
  return new;
end $$;
create trigger payments_cash_check before insert on payments
  for each row execute function check_payment_cash();

create function check_sale_cash() returns trigger language plpgsql as $$
begin
  perform assert_open_session(new.cash_session_id, new.seller_id);
  return new;
end $$;
create trigger sales_cash_check before insert on sales
  for each row execute function check_sale_cash();

create function check_return_cash() returns trigger language plpgsql as $$
begin
  perform assert_open_session(new.cash_session_id, new.created_by);
  return new;
end $$;
create trigger sale_returns_cash_check before insert on sale_returns
  for each row execute function check_return_cash();

-- Venda: agora também permite definir/alterar o vencimento (único campo mutável além do estado)
-- e registrar em qual caixa foi cancelada.
create or replace function guard_sales_update() returns trigger language plpgsql as $$
begin
  if old.status <> 'concluida' then
    raise exception 'venda % está % (estado terminal) e não pode ser alterada', old.number, old.status
      using errcode = 'restrict_violation';
  end if;
  if (new.id, new.number, new.customer_id, new.seller_id, new.subtotal_cents, new.discount_cents,
      new.total_cents, new.note, new.idempotency_key, new.request_hash, new.created_at,
      new.cash_session_id)
     is distinct from
     (old.id, old.number, old.customer_id, old.seller_id, old.subtotal_cents, old.discount_cents,
      old.total_cents, old.note, old.idempotency_key, old.request_hash, old.created_at,
      old.cash_session_id) then
    raise exception 'campos da venda % são imutáveis', old.number using errcode = 'restrict_violation';
  end if;
  if new.status = 'cancelada' then
    perform assert_open_session(new.cancel_session_id, new.cancelled_by);
  elsif new.cancel_session_id is not null then
    raise exception 'caixa de cancelamento só se aplica a venda cancelada' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

-- ---------- Fórmula única do dinheiro esperado na gaveta ----------
-- Somente DINHEIRO entra: PIX, débito e crédito nunca alteram a gaveta.
create function cash_session_expected(p_session uuid) returns integer language sql stable as $$
  select (
    s.opening_cents
    + coalesce((select sum(case pm.kind when 'recebimento' then pm.amount_cents else -pm.amount_cents end)
                from payments pm where pm.cash_session_id = s.id and pm.method = 'dinheiro'), 0)
    + coalesce((select sum(case m.direction when 'entrada' then m.amount_cents else -m.amount_cents end)
                from cash_movements m where m.session_id = s.id), 0)
  )::integer
  from cash_sessions s where s.id = p_session
$$;

-- ---------- Integridade do recebimento (verificada no COMMIT) ----------
create function check_debt_receipt_integrity(p_receipt uuid) returns void language plpgsql as $$
declare
  r debt_receipts%rowtype;
  v_sum bigint;
  v_orig_count integer;
  v_rev_count integer;
begin
  select * into r from debt_receipts where id = p_receipt;
  if not found then
    return;
  end if;
  select coalesce(sum(amount_cents), 0) into v_sum from payments where receipt_id = r.id;
  if v_sum <> r.total_cents then
    raise exception 'receipt_integrity: pagamentos do recebimento % não somam o total', r.number
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from payments pm join sales s on s.id = pm.sale_id
    where pm.receipt_id = r.id
      and (s.customer_id is distinct from r.customer_id
           or pm.kind <> r.kind
           or pm.cash_session_id is distinct from r.cash_session_id)
  ) then
    raise exception 'receipt_integrity: recebimento % com pagamento de outro cliente, tipo ou caixa', r.number
      using errcode = 'check_violation';
  end if;
  if r.kind = 'estorno' then
    -- estorno de recebimento reverte TODOS os pagamentos do original, sem sobras
    select count(*) into v_orig_count from payments where receipt_id = r.reverses_receipt_id;
    select count(*) into v_rev_count from payments pm
      where pm.receipt_id = r.id
        and exists (select 1 from payments o where o.id = pm.reverses_payment_id
                    and o.receipt_id = r.reverses_receipt_id);
    if v_orig_count = 0 or v_orig_count <> v_rev_count
       or (select count(*) from payments where receipt_id = r.id) <> v_orig_count then
      raise exception 'receipt_integrity: estorno do recebimento % incompleto', r.number
        using errcode = 'check_violation';
    end if;
  end if;
end $$;

create function trg_check_debt_receipt_integrity() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'debt_receipts' then
    perform check_debt_receipt_integrity(new.id);
  elsif new.receipt_id is not null then
    perform check_debt_receipt_integrity(new.receipt_id);
  end if;
  return null;
end $$;
create constraint trigger debt_receipts_integrity after insert on debt_receipts
  deferrable initially deferred for each row execute function trg_check_debt_receipt_integrity();
create constraint trigger payments_receipt_integrity after insert on payments
  deferrable initially deferred for each row execute function trg_check_debt_receipt_integrity();

-- ---------- Fechamento: o esperado gravado deve ser exatamente a fórmula ----------
create function check_cash_close_integrity() returns trigger language plpgsql as $$
begin
  if new.status = 'fechado' and new.expected_cents <> cash_session_expected(new.id) then
    raise exception 'cash_integrity: esperado do fechamento do caixa % não confere', new.number
      using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger cash_sessions_close_integrity after update on cash_sessions
  deferrable initially deferred for each row execute function check_cash_close_integrity();
