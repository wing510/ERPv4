-- ERP v4.2.5 遷移步驟 06：產品主檔 — 建議售價
-- 用法：Supabase SQL Editor → Run（DEV / PROD 各跑一次）

alter table product add column if not exists suggested_retail_price numeric;

comment on column product.suggested_retail_price is '牌價（標準零售參考價；選填）';
