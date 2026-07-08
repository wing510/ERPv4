-- ERP v4.2.1 遷移步驟 1：公司設定 — 應收逾期門檻（Supabase SQL Editor → Run）
-- 前置：erp_company_profile 已存在

alter table erp_company_profile
  add column if not exists ar_overdue_days_normal integer default 14;

alter table erp_company_profile
  add column if not exists ar_overdue_days_consignment integer default 30;

update erp_company_profile
set
  ar_overdue_days_normal = coalesce(ar_overdue_days_normal, 14),
  ar_overdue_days_consignment = coalesce(ar_overdue_days_consignment, 30)
where profile_id = 'DEFAULT';
