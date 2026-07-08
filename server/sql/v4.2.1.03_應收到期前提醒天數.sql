-- ERP v4.2.1 遷移步驟 3：公司設定 — 應收到期前提醒天數（Supabase SQL Editor → Run）
-- 前置：erp_company_profile 已存在；v4.2.1.01 已跑

alter table erp_company_profile
  add column if not exists ar_reminder_days_before_overdue integer default 5;

comment on column erp_company_profile.ar_reminder_days_before_overdue is
  '應收到期前提醒：距離逾期門檻尚餘 N 天內列入提醒（0=關閉）';

update erp_company_profile
set ar_reminder_days_before_overdue = coalesce(ar_reminder_days_before_overdue, 5)
where profile_id = 'DEFAULT';
