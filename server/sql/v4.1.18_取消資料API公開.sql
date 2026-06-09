-- =============================================================================
-- 檔名：v4.1.18_取消資料API公開.sql
-- 取消 public 表對 Data API 的公開（移除 Table Editor 地球圖示）
-- 適用：ERP v4.1（Node 後端用 service_role，不依賴 anon/authenticated）
-- 用法：Supabase SQL Editor → 貼上 → Run（DEV / PROD 各跑一次）
-- 注意：勿 REVOKE service_role
-- =============================================================================

-- 既有表：收回 anon / authenticated 權限
do $$
declare
  r record;
begin
  for r in
    select tablename
    from pg_tables
    where schemaname = 'public'
  loop
    execute format(
      'revoke all on table public.%I from anon, authenticated',
      r.tablename
    );
  end loop;
end $$;

-- 既有序列
do $$
declare
  r record;
begin
  for r in
    select sequence_name
    from information_schema.sequences
    where sequence_schema = 'public'
  loop
    execute format(
      'revoke all on sequence public.%I from anon, authenticated',
      r.sequence_name
    );
  end loop;
end $$;

-- 之後新建的表：預設不 grant 給 anon / authenticated
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated;
