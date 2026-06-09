-- ERP v4.1 遷移步驟 6：委外加工（Supabase SQL Editor → Run）
-- 前置：supplier / product / lot / inventory_movement（步驟 1、3、4）已存在

create table if not exists process_order (
  process_order_id text primary key,
  process_type text,
  source_type text,
  supplier_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  planned_date date,
  status text default 'OPEN',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists process_order_input (
  process_input_id text primary key,
  process_order_id text not null,
  lot_id text,
  product_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  issue_qty numeric default 0,
  unit text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists process_order_output (
  process_output_id text primary key,
  process_order_id text not null,
  lot_id text,
  product_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  receive_qty numeric default 0,
  unit text,
  loss_base_qty_after numeric,
  loss_base_unit text,
  status text default 'CREATED',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists lot_relation (
  relation_id text primary key,
  relation_type text,
  from_lot_id text,
  to_lot_id text,
  qty numeric default 0,
  unit text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  ref_type text,
  ref_id text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create index if not exists idx_proc_supplier on process_order (supplier_id);
create index if not exists idx_proc_status on process_order (status);
create index if not exists idx_proc_created on process_order (created_at);
create index if not exists idx_poi_proc on process_order_input (process_order_id);
create index if not exists idx_poi_lot on process_order_input (lot_id);
create index if not exists idx_poo_proc on process_order_output (process_order_id);
create index if not exists idx_poo_lot on process_order_output (lot_id);
create index if not exists idx_rel_from on lot_relation (from_lot_id);
create index if not exists idx_rel_to on lot_relation (to_lot_id);
create index if not exists idx_rel_ref on lot_relation (ref_type, ref_id);

alter table process_order enable row level security;
alter table process_order_input enable row level security;
alter table process_order_output enable row level security;
alter table lot_relation enable row level security;
