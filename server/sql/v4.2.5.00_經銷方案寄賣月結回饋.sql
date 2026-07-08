-- ERP v4.2.5 遷移步驟 0：Dealer 經銷方案（寄賣月結回饋）
-- 用法：Supabase SQL Editor → Run（DEV / PROD 各跑一次）

-- ── 經銷方案表頭 ─────────────────────────────────────────────
create table if not exists commercial_dealer_scheme (
  scheme_id text primary key,
  scheme_name text not null,
  status text default 'ACTIVE',
  date_from date not null,
  date_to date not null,
  scheme_type text not null default 'MONTHLY_REBATE',
  stat_source text not null default 'CONSIGNMENT',
  mutex_group text default 'MONTHLY_REBATE',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

comment on table commercial_dealer_scheme is 'Dealer 經銷方案（月結回饋級距等）';
comment on column commercial_dealer_scheme.scheme_type is 'MONTHLY_REBATE 等';
comment on column commercial_dealer_scheme.stat_source is 'CONSIGNMENT／GENERAL／ALL（第一版用 CONSIGNMENT）';

-- ── 級距明細 ─────────────────────────────────────────────
create table if not exists commercial_dealer_scheme_tier (
  tier_id text primary key,
  scheme_id text not null references commercial_dealer_scheme (scheme_id) on delete cascade,
  line_no int not null default 1,
  amount_from numeric not null default 0,
  amount_to numeric,
  rebate_pct numeric not null default 0,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);

comment on table commercial_dealer_scheme_tier is '經銷方案級距（月結金額區間 → 回饋%）';
comment on column commercial_dealer_scheme_tier.amount_from is '含下限';
comment on column commercial_dealer_scheme_tier.amount_to is '含上限；空白表示無上限';

create index if not exists idx_cd_dealer_tier_scheme on commercial_dealer_scheme_tier (scheme_id);

-- ── 月結回饋紀錄（快照）────────────────────────────────────
create table if not exists commercial_dealer_rebate (
  rebate_id text primary key,
  customer_id text not null,
  period_ym text not null,
  scheme_id text not null,
  scheme_name_snapshot text,
  billing_net numeric not null default 0,
  rebate_pct numeric not null default 0,
  rebate_amount numeric not null default 0,
  tier_snapshot_json text,
  settle_mode text not null default 'CREDIT_NOTE',
  status text not null default 'POSTED',
  ar_id text,
  credit_applied numeric default 0,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

comment on table commercial_dealer_rebate is '寄賣月結回饋紀錄（快照）';
comment on column commercial_dealer_rebate.period_ym is 'YYYY-MM';
comment on column commercial_dealer_rebate.settle_mode is 'CREDIT_NOTE 折讓／CARRY_FORWARD 下期折抵';
comment on column commercial_dealer_rebate.ar_id is '折讓時套用的應收單號';

create unique index if not exists idx_cd_rebate_customer_period
  on commercial_dealer_rebate (customer_id, period_ym)
  where status <> 'VOID';

create index if not exists idx_cd_rebate_customer on commercial_dealer_rebate (customer_id);

-- ── 客戶欄位 ─────────────────────────────────────────────
alter table customer add column if not exists dealer_scheme_id text;
alter table customer add column if not exists dealer_rebate_settle_mode text default 'CREDIT_NOTE';
alter table customer add column if not exists dealer_rebate_excluded boolean default false;
alter table customer add column if not exists dealer_rebate_credit_balance numeric default 0;

comment on column customer.dealer_scheme_id is '套用之 Dealer 經銷方案';
comment on column customer.dealer_rebate_settle_mode is 'CREDIT_NOTE／CARRY_FORWARD';
comment on column customer.dealer_rebate_excluded is 'true 則不參加月結回饋';
comment on column customer.dealer_rebate_credit_balance is '下期折抵可用餘額';

-- ── RLS + 取消 Data API 公開 ───────────────────────────────
alter table commercial_dealer_scheme enable row level security;
alter table commercial_dealer_scheme_tier enable row level security;
alter table commercial_dealer_rebate enable row level security;

revoke all on table public.commercial_dealer_scheme from anon, authenticated;
revoke all on table public.commercial_dealer_scheme_tier from anon, authenticated;
revoke all on table public.commercial_dealer_rebate from anon, authenticated;
