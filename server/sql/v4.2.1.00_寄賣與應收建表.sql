-- ERP v4.2.1 遷移步驟 0：寄賣追蹤 + 應收帳款（Supabase SQL Editor → Run）
-- 前置：v4.1 銷售/出貨表已存在

-- ── 寄賣追蹤（一張 POSTED 出貨 → 一筆） ─────────────────
create table if not exists consignment_track (
  track_id text primary key,
  shipment_id text not null unique,
  so_id text not null,
  customer_id text,
  transaction_id text,
  ship_date date,
  status text default 'OPEN',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists consignment_track_item (
  track_item_id text primary key,
  track_id text not null,
  shipment_item_id text not null,
  so_item_id text,
  product_id text,
  ship_qty numeric default 0,
  settled_qty numeric default 0,
  unit text,
  unit_price numeric default 0,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

-- ── 寄賣結算 ───────────────────────────────────────────
create table if not exists consignment_settlement (
  settlement_id text primary key,
  track_id text not null,
  shipment_id text,
  so_id text,
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

create table if not exists consignment_settlement_item (
  settlement_item_id text primary key,
  settlement_id text not null,
  track_item_id text not null,
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

-- ── 應收帳款 ─────────────────────────────────────────────
create table if not exists ar_receivable (
  ar_id text primary key,
  source_type text not null,
  source_id text not null,
  customer_id text,
  so_id text,
  shipment_id text,
  settlement_id text,
  transaction_id text,
  ar_date date,
  currency text default 'USD',
  amount_system numeric default 0,
  amount_due numeric default 0,
  amount_received numeric default 0,
  status text default 'OPEN',
  close_mode text,
  close_reason text,
  closed_by text,
  closed_at timestamptz,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists ar_payment (
  payment_id text primary key,
  ar_id text not null,
  payment_date date,
  amount numeric default 0,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists ar_amount_adjustment_log (
  adjust_id text primary key,
  ar_id text not null,
  amount_before numeric default 0,
  amount_after numeric default 0,
  reason text not null,
  adjusted_by text,
  adjusted_at timestamptz default now()
);

create index if not exists idx_ct_shipment on consignment_track (shipment_id);
create index if not exists idx_ct_so on consignment_track (so_id);
create index if not exists idx_ct_status on consignment_track (status);
create index if not exists idx_cti_track on consignment_track_item (track_id);
create index if not exists idx_cs_track on consignment_settlement (track_id);
create index if not exists idx_cs_ar on consignment_settlement (ar_id);
create index if not exists idx_ar_customer on ar_receivable (customer_id);
create index if not exists idx_ar_status on ar_receivable (status);
create index if not exists idx_ar_source on ar_receivable (source_type, source_id);
create index if not exists idx_ar_date on ar_receivable (ar_date);
create index if not exists idx_ap_ar on ar_payment (ar_id);

alter table consignment_track enable row level security;
alter table consignment_track_item enable row level security;
alter table consignment_settlement enable row level security;
alter table consignment_settlement_item enable row level security;
alter table ar_receivable enable row level security;
alter table ar_payment enable row level security;
alter table ar_amount_adjustment_log enable row level security;

-- 新表：取消 Data API 公開（service_role 不受影響）
revoke all on table public.consignment_track from anon, authenticated;
revoke all on table public.consignment_track_item from anon, authenticated;
revoke all on table public.consignment_settlement from anon, authenticated;
revoke all on table public.consignment_settlement_item from anon, authenticated;
revoke all on table public.ar_receivable from anon, authenticated;
revoke all on table public.ar_payment from anon, authenticated;
revoke all on table public.ar_amount_adjustment_log from anon, authenticated;
