-- ERP v4.2.3 遷移步驟 0：寄賣促銷方案（Supabase SQL Editor → Run）
-- 前置：v4.2.2 寄賣案件表已存在

-- ── 促銷方案表頭 ─────────────────────────────────────────────
create table if not exists consignment_promo_scheme (
  scheme_id text primary key,
  scheme_name text not null,
  status text default 'ACTIVE',
  date_from date not null,
  date_to date not null,
  scope_type text not null default 'CUSTOMER',
  case_id text,
  customer_id text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

comment on table consignment_promo_scheme is 'v4.2.3 寄賣促銷方案表頭';
comment on column consignment_promo_scheme.status is 'DRAFT／ACTIVE／ENDED';
comment on column consignment_promo_scheme.scope_type is 'CASE／CUSTOMER／GLOBAL';
comment on column consignment_promo_scheme.case_id is 'scope_type=CASE 時必填';
comment on column consignment_promo_scheme.customer_id is 'scope_type=CUSTOMER 時必填';

-- ── 促銷方案明細 ─────────────────────────────────────────────
create table if not exists consignment_promo_scheme_line (
  line_id text primary key,
  scheme_id text not null,
  product_id text not null,
  promo_type text not null,
  promo_unit_price numeric,
  discount_pct numeric,
  buy_qty numeric,
  free_qty numeric,
  sort_order int default 0,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

comment on table consignment_promo_scheme_line is 'v4.2.3 寄賣促銷方案明細';
comment on column consignment_promo_scheme_line.promo_type is 'FIXED_PRICE／DISCOUNT_PCT／BUY_N_GET_M';

create index if not exists idx_cc_promo_line_scheme on consignment_promo_scheme_line (scheme_id);
create index if not exists idx_cc_promo_line_product on consignment_promo_scheme_line (product_id);
create index if not exists idx_cc_promo_scheme_customer on consignment_promo_scheme (customer_id);
create index if not exists idx_cc_promo_scheme_case on consignment_promo_scheme (case_id);

-- ── 結算明細擴欄（促銷計價）──────────────────────────────────
alter table consignment_case_settlement_item
  add column if not exists billable_qty numeric;
alter table consignment_case_settlement_item
  add column if not exists free_qty numeric default 0;
alter table consignment_case_settlement_item
  add column if not exists list_unit_price numeric;
alter table consignment_case_settlement_item
  add column if not exists settle_unit_price numeric;
alter table consignment_case_settlement_item
  add column if not exists promo_scheme_id text;
alter table consignment_case_settlement_item
  add column if not exists promo_type text;

comment on column consignment_case_settlement_item.billable_qty is '計價量（買N送M時可能小於 settle_qty）';
comment on column consignment_case_settlement_item.free_qty is '贈送量';
comment on column consignment_case_settlement_item.list_unit_price is '池子牌價（對照）';
comment on column consignment_case_settlement_item.settle_unit_price is '結算單價（套用促銷後）';

-- 舊資料補齊（若欄位為空則視同無促銷）
update consignment_case_settlement_item
set
  billable_qty = coalesce(billable_qty, settle_qty),
  free_qty = coalesce(free_qty, 0),
  list_unit_price = coalesce(list_unit_price, unit_price),
  settle_unit_price = coalesce(settle_unit_price, unit_price)
where billable_qty is null or settle_unit_price is null;

-- ── RLS + 取消 Data API 公開（與 v4.2.2 寄賣表相同；ERP 僅 Node service_role 存取）──
alter table consignment_promo_scheme enable row level security;
alter table consignment_promo_scheme_line enable row level security;

revoke all on table public.consignment_promo_scheme from anon, authenticated;
revoke all on table public.consignment_promo_scheme_line from anon, authenticated;
