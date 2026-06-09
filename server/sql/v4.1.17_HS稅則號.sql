-- ERP v4.1 step17：產品稅則號 + CI 明細快照（PDF HS Code 欄）
-- 在 Supabase SQL Editor 執行一次

alter table product add column if not exists hs_code text;
comment on column product.hs_code is '稅則號（HS Code）；Commercial Invoice PDF 選用欄位';

alter table commercial_invoice_line add column if not exists hs_code text;
comment on column commercial_invoice_line.hs_code is '稅則號快照（開立 CI 時自產品帶入）';
