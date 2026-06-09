-- ERP v4.1 遷移步驟 1：主檔（Supabase SQL Editor 執行，選 Run and enable RLS）

create table if not exists supplier (
  supplier_id text primary key,
  supplier_name text,
  contact_person text,
  phone text,
  email text,
  address text,
  country text,
  supplier_type text,
  supplier_flow text,
  status text default 'ACTIVE',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);

create table if not exists customer (
  customer_id text primary key,
  customer_name text,
  category text,
  contact_person text,
  phone text,
  email text,
  address text,
  country text,
  status text default 'ACTIVE',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);

create table if not exists warehouse (
  warehouse_id text primary key,
  warehouse_name text,
  category text,
  address text,
  status text default 'ACTIVE',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);

-- 勿用表名 user（PostgreSQL 保留字，Supabase 開 RLS 會語法錯誤）
create table if not exists erp_user (
  user_id text primary key,
  user_name text,
  email text,
  role text,
  status text default 'ACTIVE',
  allowed_modules text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);

create index if not exists idx_supplier_status on supplier (status);
create index if not exists idx_customer_status on customer (status);
create index if not exists idx_warehouse_status on warehouse (status);
create index if not exists idx_erp_user_email on erp_user (email);

alter table supplier enable row level security;
alter table customer enable row level security;
alter table warehouse enable row level security;
alter table erp_user enable row level security;
