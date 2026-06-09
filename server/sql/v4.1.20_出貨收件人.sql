-- =============================================================================
-- 檔名：v4.1.20_出貨收件人.sql
-- 出貨單記錄收件人（關聯 customer_recipient，並快照姓名／地址／電話供 PDF）
-- 用法：Supabase SQL Editor → Run（DEV / PROD 各跑一次）
-- =============================================================================

alter table shipment add column if not exists recipient_id text;
alter table shipment add column if not exists recipient_name text;
alter table shipment add column if not exists recipient_address text;
alter table shipment add column if not exists recipient_phone text;

create index if not exists idx_shipment_recipient on shipment (recipient_id);
