-- ERP v4.2.2 遷移步驟 0：寄賣案件（Supabase SQL Editor → Run）
-- 前置：v4.1 銷售/出貨、v4.2.1 應收表已存在
-- 說明：v4.2.2 以「寄賣案件」取代 CT 追蹤；舊 consignment_track* 表保留供 DEV 清空，新功能走本案表

-- ── 出貨可掛案件（選填；過帳寫入品項池時一併帶入）────────────────
alter table shipment
  add column if not exists consignment_case_id text;

create index if not exists idx_ship_case on shipment (consignment_case_id);

comment on column shipment.consignment_case_id is 'v4.2.2 寄賣出貨所掛案件編號';

-- ── 寄賣案件（手動開案）────────────────────────────────────
create table if not exists consignment_case (
  case_id text primary key,
  customer_id text not null,
  status text default 'OPEN',
  -- 分配政策：FIFO=先出先退；HIGH_PRICE_FIRST=高價先退；PRICE_IF_GIVEN=有填單價才篩選後先出先退
  allocation_policy text default 'FIFO',
  open_date date,
  close_date date,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

comment on table consignment_case is 'v4.2.2 寄賣案件表頭';
comment on column consignment_case.allocation_policy is '收回匹配：FIFO／HIGH_PRICE_FIRST／PRICE_IF_GIVEN';

-- ── 案件品項池（每次寄賣出貨過帳累加）────────────────────────
create table if not exists consignment_case_pool_item (
  pool_item_id text primary key,
  case_id text not null,
  shipment_id text not null,
  shipment_item_id text not null,
  so_id text,
  so_item_id text,
  product_id text,
  lot_id text,
  factory_lot text,
  warehouse_id text,
  ship_qty numeric default 0,
  settled_qty numeric default 0,
  returned_qty numeric default 0,
  unit text,
  unit_price numeric default 0,
  ship_date date,
  transaction_id text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

comment on table consignment_case_pool_item is 'v4.2.2 寄賣案件品項池（出貨累加）';
comment on column consignment_case_pool_item.factory_lot is '加工廠 Lot（標籤批號；通常自 lot 主檔帶出）';
comment on column consignment_case_pool_item.warehouse_id is '出貨批號原倉（收回預設退回倉）';

-- ── 寄賣案件結算 ───────────────────────────────────────────
create table if not exists consignment_case_settlement (
  settlement_id text primary key,
  case_id text not null,
  customer_id text,
  transaction_id text,
  settlement_date date,
  amount_system numeric default 0,
  ar_id text,
  status text default 'POSTED',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

comment on table consignment_case_settlement is 'v4.2.2 寄賣案件結算表頭';

create table if not exists consignment_case_settlement_item (
  settlement_item_id text primary key,
  settlement_id text not null,
  pool_item_id text not null,
  shipment_item_id text,
  so_item_id text,
  product_id text,
  settle_qty numeric default 0,
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

comment on table consignment_case_settlement_item is 'v4.2.2 寄賣案件結算明細';

-- ── 寄賣案件收回 ───────────────────────────────────────────
create table if not exists consignment_case_return (
  return_id text primary key,
  case_id text not null,
  customer_id text,
  transaction_id text,
  -- 退回原因：UNSOLD=未售；CASE_CLOSE=結案清退；SOLD_RETURN/DAMAGED/EXPIRED/WRONG_GOODS=第二版
  return_reason text not null,
  return_date date,
  return_warehouse_id text not null,
  filter_unit_price numeric,
  status text default 'POSTED',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

comment on table consignment_case_return is 'v4.2.2 寄賣案件收回表頭';
comment on column consignment_case_return.return_reason is 'UNSOLD／CASE_CLOSE／SOLD_RETURN／DAMAGED／EXPIRED／WRONG_GOODS';
comment on column consignment_case_return.return_warehouse_id is '退回倉庫';
comment on column consignment_case_return.filter_unit_price is '可選；收回單有填單價時用於匹配';

create table if not exists consignment_case_return_item (
  return_item_id text primary key,
  return_id text not null,
  factory_lot text not null,
  product_id text,
  return_qty numeric default 0,
  pool_item_id text,
  shipment_item_id text,
  so_item_id text,
  lot_id text,
  recognized_unit_price numeric default 0,
  unit text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

comment on table consignment_case_return_item is 'v4.2.2 寄賣案件收回明細';
comment on column consignment_case_return_item.factory_lot is '操作員輸入的加工廠 Lot';
comment on column consignment_case_return_item.recognized_unit_price is '匹配後認列的出貨單價';

-- ── 索引 ───────────────────────────────────────────────────
create index if not exists idx_ccase_customer on consignment_case (customer_id);
create index if not exists idx_ccase_status on consignment_case (status);
create index if not exists idx_ccpi_case on consignment_case_pool_item (case_id);
create index if not exists idx_ccpi_shipment on consignment_case_pool_item (shipment_id);
create index if not exists idx_ccpi_factory_lot on consignment_case_pool_item (factory_lot);
create index if not exists idx_ccpi_product on consignment_case_pool_item (product_id);
create index if not exists idx_ccs_case on consignment_case_settlement (case_id);
create index if not exists idx_ccs_ar on consignment_case_settlement (ar_id);
create index if not exists idx_ccsi_settlement on consignment_case_settlement_item (settlement_id);
create index if not exists idx_ccsi_pool on consignment_case_settlement_item (pool_item_id);
create index if not exists idx_ccret_case on consignment_case_return (case_id);
create index if not exists idx_ccreti_return on consignment_case_return_item (return_id);
create index if not exists idx_ccreti_pool on consignment_case_return_item (pool_item_id);

-- ── RLS + 取消 Data API 公開 ───────────────────────────────
alter table consignment_case enable row level security;
alter table consignment_case_pool_item enable row level security;
alter table consignment_case_settlement enable row level security;
alter table consignment_case_settlement_item enable row level security;
alter table consignment_case_return enable row level security;
alter table consignment_case_return_item enable row level security;

revoke all on table public.consignment_case from anon, authenticated;
revoke all on table public.consignment_case_pool_item from anon, authenticated;
revoke all on table public.consignment_case_settlement from anon, authenticated;
revoke all on table public.consignment_case_settlement_item from anon, authenticated;
revoke all on table public.consignment_case_return from anon, authenticated;
revoke all on table public.consignment_case_return_item from anon, authenticated;
