-- Fase 8 (correção): a venda offline preserva o caixa em que foi realizada.
-- Se esse caixa já foi fechado, a venda só entra por REGULARIZAÇÃO aprovada por gerente/admin:
-- o fechamento original permanece intacto e a venda é registrada UMA vez, no caixa aberto do
-- vendedor, com referência ao caixa de origem.

alter table sync_operations
  add column cash_session_id uuid references cash_sessions (id) on delete restrict;

alter table sales
  add column origin_cash_session_id uuid references cash_sessions (id) on delete restrict;

alter table payments
  add column regularization boolean not null default false,
  add column origin_cash_session_id uuid references cash_sessions (id) on delete restrict,
  add constraint payments_regularization_origin_ck
    check (regularization = (origin_cash_session_id is not null));

-- Recebimentos regularizados NÃO alteram o dinheiro esperado de nenhuma gaveta: o dinheiro já
-- existia fisicamente (foi vendido antes do fechamento original) e não pode ser contado duas vezes.
-- Eles seguem aparecendo por modalidade no caixa de destino.
create or replace function cash_session_expected(p_session uuid) returns integer language sql stable as $$
  select (
    s.opening_cents
    + coalesce((select sum(case pm.kind when 'recebimento' then pm.amount_cents else -pm.amount_cents end)
                from payments pm
                where pm.cash_session_id = s.id and pm.method = 'dinheiro' and not pm.regularization), 0)
    + coalesce((select sum(case m.direction when 'entrada' then m.amount_cents else -m.amount_cents end)
                from cash_movements m where m.session_id = s.id), 0)
  )::integer
  from cash_sessions s where s.id = p_session
$$;

-- Registro auditável de cada regularização (imutável).
create table cash_regularizations (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique references sync_operations (operation_id) on delete restrict,
  sale_id uuid not null unique references sales (id) on delete restrict,
  origin_session_id uuid not null references cash_sessions (id) on delete restrict,
  target_session_id uuid not null references cash_sessions (id) on delete restrict,
  cash_cents integer not null check (cash_cents >= 0),
  received_cents integer not null check (received_cents >= 0),
  approved_by uuid not null references users (id),
  note text not null,
  created_at timestamptz not null default now(),
  check (origin_session_id <> target_session_id)
);
create index cash_regularizations_origin_idx on cash_regularizations (origin_session_id);
create index cash_regularizations_target_idx on cash_regularizations (target_session_id);
create trigger cash_regularizations_immutable before update or delete on cash_regularizations
  for each row execute function forbid_mutation();
