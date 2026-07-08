-- ERP v4.2.5 遷移步驟 03：客戶主檔 — 月結回饋／累積金額制分離 + 累積狀態欄位
-- 用法：Supabase SQL Editor → Run（DEV / PROD 各跑一次）
-- 前置：v4.2.5.00、v4.2.5.02

-- ── 方案（月結回饋 vs 累積金額制 各選一套）────────────────
alter table customer add column if not exists dealer_rebate_scheme_id text;
alter table customer add column if not exists dealer_cumulative_scheme_id text;

comment on column customer.dealer_rebate_scheme_id is '月結回饋方案（MONTHLY_REBATE）';
comment on column customer.dealer_cumulative_scheme_id is '累積金額制方案（CUMULATIVE_AMOUNT）';
comment on column customer.dealer_scheme_id is '相容舊欄；請改存月結回饋方案 ID';

-- ── 累積採購與等級（系統維護，客戶主檔唯讀顯示）────────────
alter table customer add column if not exists dealer_cumulative_amount numeric not null default 0;
alter table customer add column if not exists dealer_cumulative_tier_label text default '';
alter table customer add column if not exists dealer_cumulative_price_rate numeric;
alter table customer add column if not exists dealer_cumulative_pending_tier_label text default '';
alter table customer add column if not exists dealer_cumulative_pending_price_rate numeric;
alter table customer add column if not exists dealer_cumulative_started_at date;

comment on column customer.dealer_cumulative_amount is '累積採購金額（請款淨額加總）';
comment on column customer.dealer_cumulative_tier_label is '目前等級名稱（本月結算套用）';
comment on column customer.dealer_cumulative_price_rate is '目前經銷價折數（如 85 表示 85 折）';
comment on column customer.dealer_cumulative_pending_tier_label is '次月待生效等級';
comment on column customer.dealer_cumulative_pending_price_rate is '次月待生效經銷價折數';
comment on column customer.dealer_cumulative_started_at is '累積起算日（可空白＝啟用日起算）';

-- ── 舊資料搬移（dealer_scheme_id → 依方案類型拆分）──────────
update customer c
set dealer_cumulative_scheme_id = c.dealer_scheme_id
from commercial_dealer_scheme s
where s.scheme_id = c.dealer_scheme_id
  and upper(coalesce(s.scheme_type, '')) = 'CUMULATIVE_AMOUNT'
  and coalesce(trim(c.dealer_cumulative_scheme_id), '') = '';

update customer c
set dealer_rebate_scheme_id = c.dealer_scheme_id
from commercial_dealer_scheme s
where s.scheme_id = c.dealer_scheme_id
  and upper(coalesce(s.scheme_type, 'MONTHLY_REBATE')) = 'MONTHLY_REBATE'
  and coalesce(trim(c.dealer_rebate_scheme_id), '') = '';

update customer
set dealer_rebate_scheme_id = dealer_scheme_id
where coalesce(trim(dealer_rebate_scheme_id), '') = ''
  and coalesce(trim(dealer_cumulative_scheme_id), '') = ''
  and coalesce(trim(dealer_scheme_id), '') <> '';

update customer
set dealer_scheme_id = dealer_rebate_scheme_id
where coalesce(trim(dealer_rebate_scheme_id), '') <> ''
  and coalesce(dealer_scheme_id, '') is distinct from dealer_rebate_scheme_id;
