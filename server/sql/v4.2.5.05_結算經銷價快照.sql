-- ERP v4.2.5 遷移步驟 05：寄賣結算 — 累積金額制經銷價快照
-- 用法：Supabase SQL Editor → Run（DEV / PROD 各跑一次）
-- 前置：v4.2.5.02、v4.2.5.03

alter table consignment_case_settlement add column if not exists dealer_cumulative_tier_label text default '';
alter table consignment_case_settlement add column if not exists dealer_cumulative_price_rate numeric;
alter table consignment_case_settlement add column if not exists dealer_cumulative_price_source text default '';

comment on column consignment_case_settlement.dealer_cumulative_tier_label is '結算套用等級（累積金額制快照）';
comment on column consignment_case_settlement.dealer_cumulative_price_rate is '結算套用經銷價折數（如 85）';
comment on column consignment_case_settlement.dealer_cumulative_price_source is 'CURRENT=目前等級；PENDING=次月待生效已於本月結算套用';
