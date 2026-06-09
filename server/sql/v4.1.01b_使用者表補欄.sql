-- 若先前建表卡在 "user"：只跑這段即可（不必再選 Supabase 的 Run and enable RLS 精靈）

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

create index if not exists idx_erp_user_email on erp_user (email);
alter table erp_user enable row level security;
