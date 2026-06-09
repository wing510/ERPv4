-- =============================================================================
-- 檔名：v4.1.19_客戶收件人.sql
-- 客戶可維護多筆收件人（姓名、地址、電話）
-- 用法：Supabase SQL Editor → Run（DEV / PROD 各跑一次）
-- =============================================================================

create table if not exists customer_recipient (
  recipient_id text primary key,
  customer_id text not null,
  recipient_name text,
  address text,
  phone text,
  status text default 'ACTIVE',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);

create index if not exists idx_customer_recipient_customer on customer_recipient (customer_id);
create index if not exists idx_customer_recipient_status on customer_recipient (status);

alter table customer_recipient enable row level security;
