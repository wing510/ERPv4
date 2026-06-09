-- ERP v4.1 step11：公司資料中英欄位（erp_company_profile）
-- 在 Supabase SQL Editor 執行一次（step10 已跑過亦可）

alter table erp_company_profile add column if not exists company_name_zh text;
alter table erp_company_profile add column if not exists address_zh text;
alter table erp_company_profile add column if not exists city_zh text;
alter table erp_company_profile add column if not exists country_zh text default '台灣';

comment on column erp_company_profile.company_name_zh is '公司名稱（中文）';
comment on column erp_company_profile.address_zh is '地址（中文）';
comment on column erp_company_profile.city_zh is '城市（中文）';
comment on column erp_company_profile.country_zh is '國家（中文）';
