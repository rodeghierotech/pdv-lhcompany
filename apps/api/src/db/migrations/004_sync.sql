-- Fase 8: dispositivos, fila de sincronização offline e conflitos.

create table devices (
  id uuid primary key,                       -- gerado no cliente e persistido no IndexedDB
  user_id uuid not null references users (id),
  label text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- Cada operação offline recebida. operation_id é a chave de deduplicação global;
-- (device_id, sequence) impede reaproveitar a sequência local com outro conteúdo.
create table sync_operations (
  operation_id uuid primary key,
  device_id uuid not null references devices (id),
  sequence bigint not null check (sequence >= 0),
  user_id uuid not null references users (id),
  type text not null check (type in ('create_sale')),
  payload jsonb not null,
  request_hash text not null,
  depends_on uuid[] not null default '{}',
  reverses_operation_id uuid references sync_operations (operation_id),
  client_created_at timestamptz not null,
  received_at timestamptz not null default now(),
  status text not null check (status in ('confirmada', 'falha_recuperavel', 'conflito')),
  attempts integer not null default 1,
  last_error_code text,
  last_error_message text,
  sale_id uuid references sales (id) on delete restrict,
  resolved_by uuid references users (id),
  resolved_at timestamptz,
  resolution text check (resolution in ('aprovada', 'descartada')),
  resolution_note text,
  updated_at timestamptz not null default now(),
  unique (device_id, sequence),
  constraint sync_confirmed_has_sale_ck check (status <> 'confirmada' or sale_id is not null or resolution = 'descartada')
);
create index sync_operations_status_idx on sync_operations (status, received_at desc);

-- Conflitos/divergências detectados ao aplicar uma operação (informativos ou bloqueantes).
create table sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references sync_operations (operation_id) on delete restrict,
  code text not null,
  blocking boolean not null,
  message text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now(),
  acknowledged_by uuid references users (id),
  acknowledged_at timestamptz
);
create index sync_conflicts_op_idx on sync_conflicts (operation_id);
create index sync_conflicts_open_idx on sync_conflicts (created_at desc) where acknowledged_at is null;

-- Origem da venda
alter table sales
  add column origin text not null default 'online' check (origin in ('online', 'offline')),
  add column sync_operation_id uuid unique
    references sync_operations (operation_id) deferrable initially deferred;
