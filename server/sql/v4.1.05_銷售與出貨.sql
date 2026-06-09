-- ERP v4.1 遷移步驟 5：銷售單 + 出貨（Supabase SQL Editor → Run）
-- 前置：customer / product / lot / inventory_movement（步驟 1、3、4）已存在

-- ── 銷售單 ─────────────────────────────────────────────
create table if not exists sales_order (
  so_id text primary key,
  customer_id text,
  salesperson_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  so_type text default 'NORMAL',
  reship_ref_type text,
  reship_ref_id text,
  order_date date,
  status text default 'OPEN',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists sales_order_item (
  so_item_id text primary key,
  so_id text not null,
  product_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  order_qty numeric default 0,
  shipped_qty numeric default 0,
  unit text,
  unit_price numeric default 0,
  amount numeric default 0,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

-- ── 出貨單 ─────────────────────────────────────────────
create table if not exists shipment (
  shipment_id text primary key,
  so_id text not null,
  customer_id text,
  shipper_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  ship_date date,
  status text default 'POSTED',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists shipment_item (
  shipment_item_id text primary key,
  shipment_id text not null,
  so_id text,
  so_item_id text,
  lot_id text,
  product_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  ship_qty numeric default 0,
  unit text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create index if not exists idx_so_customer on sales_order (customer_id);
create index if not exists idx_so_status on sales_order (status);
create index if not exists idx_so_created on sales_order (created_at);
create index if not exists idx_soi_so on sales_order_item (so_id);
create index if not exists idx_soi_product on sales_order_item (product_id);

create index if not exists idx_ship_so on shipment (so_id);
create index if not exists idx_ship_status on shipment (status);
create index if not exists idx_ship_created on shipment (created_at);
create index if not exists idx_shi_ship on shipment_item (shipment_id);
create index if not exists idx_shi_so on shipment_item (so_id);
create index if not exists idx_shi_lot on shipment_item (lot_id);

alter table sales_order enable row level security;
alter table sales_order_item enable row level security;
alter table shipment enable row level security;
alter table shipment_item enable row level security;
