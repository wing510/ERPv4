-- ERP v4.2.5 遷移步驟 04：月結回饋 — 累積異動快照欄位
-- 用法：Supabase SQL Editor → Run（DEV / PROD 各跑一次）
-- 前置：v4.2.5.03

alter table commercial_dealer_rebate add column if not exists cumulative_added numeric not null default 0;
alter table commercial_dealer_rebate add column if not exists cumulative_before numeric;
alter table commercial_dealer_rebate add column if not exists cumulative_after numeric;
alter table commercial_dealer_rebate add column if not exists cumulative_pending_tier_label text default '';
alter table commercial_dealer_rebate add column if not exists cumulative_pending_price_rate numeric;

comment on column commercial_dealer_rebate.cumulative_added is '本月加入累積採購（=請款淨額）';
comment on column commercial_dealer_rebate.cumulative_before is '月結前累積採購';
comment on column commercial_dealer_rebate.cumulative_after is '月結後累積採購';
comment on column commercial_dealer_rebate.cumulative_pending_tier_label is '本次判定次月待生效等級（若有升級）';
comment on column commercial_dealer_rebate.cumulative_pending_price_rate is '本次判定次月待生效經銷價折數';
