-- ERP v4.2.1 遷移步驟 2：寄賣未售退回（Supabase SQL Editor → Run）
-- 前置：v4.2.1.00 寄賣追蹤表已存在

-- 追蹤明細：累計已退回量
alter table consignment_track_item
  add column if not exists returned_qty numeric default 0;

-- ── 寄賣未售退回 ─────────────────────────────────────────
create table if not exists consignment_return (
  return_id text primary key,
  track_id text not null,
  shipment_id text,
  so_id text,
  customer_id text,
  transaction_id text,
  return_date date,
  status text default 'POSTED',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists consignment_return_item (
  return_item_id text primary key,
  return_id text not null,
  track_item_id text not null,
  shipment_item_id text,
  so_item_id text,
  product_id text,
  lot_id text,
  return_qty numeric default 0,
  unit text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create index if not exists idx_cret_track on consignment_return (track_id);
create index if not exists idx_creti_return on consignment_return_item (return_id);
create index if not exists idx_creti_track_item on consignment_return_item (track_item_id);

alter table consignment_return enable row level security;
alter table consignment_return_item enable row level security;

revoke all on table public.consignment_return from anon, authenticated;
revoke all on table public.consignment_return_item from anon, authenticated;
