-- =============================================================================
-- 檔名：v4.1.21_收件人英文姓名.sql
-- 收件人：中文姓名（recipient_name）+ 英文姓名（recipient_name_en）
-- 用法：Supabase SQL Editor → Run（DEV / PROD 各跑一次）
-- =============================================================================

alter table customer_recipient add column if not exists recipient_name_en text;
comment on column customer_recipient.recipient_name is '收件人中文姓名';
comment on column customer_recipient.recipient_name_en is '收件人英文姓名';

alter table shipment add column if not exists recipient_name_en text;
