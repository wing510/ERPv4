-- ERP v4.2.5 遷移步驟 02：Dealer 經銷方案 — 累積金額制級距欄位
-- 用法：Supabase SQL Editor → Run（DEV / PROD 各跑一次）

alter table commercial_dealer_scheme_tier
  add column if not exists tier_label text default '',
  add column if not exists price_rate numeric;

comment on column commercial_dealer_scheme_tier.tier_label is '等級名稱（累積金額制，如銀級、金級）';
comment on column commercial_dealer_scheme_tier.price_rate is '經銷價折數（累積金額制，如 85 表示 85 折）';
comment on column commercial_dealer_scheme.scheme_type is 'MONTHLY_REBATE 月結回饋／CUMULATIVE_AMOUNT 累積金額制';
