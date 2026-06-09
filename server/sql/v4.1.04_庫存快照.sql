-- ERP v4.1 遷移步驟 4：庫存快照（若步驟 0 已建可略過）

create table if not exists lot_balance (
  lot_id text primary key,
  available_qty numeric default 0,
  movement_count integer default 0,
  last_movement_id text,
  updated_at timestamptz default now(),
  updated_by text
);

create index if not exists idx_lot_balance_updated on lot_balance (updated_at);

alter table lot_balance enable row level security;
