-- ERP v4.1 step12：公司章（Commercial Invoice 列印簽章用）
-- 在 Supabase SQL Editor 執行一次

alter table erp_company_profile add column if not exists company_seal_url text;

comment on column erp_company_profile.company_seal_url is '公司章圖片 URL 或 data:image/... Base64（CI PDF 簽章區）';
