-- v4.1 step8：供 ERP 前端「Supabase」按鈕解析 Table Editor 連結
-- 在 Supabase SQL Editor 執行一次即可

create or replace function public.erp_pg_table_oid(p_table text)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select c.oid::bigint
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = lower(trim(p_table))
    and c.relkind = 'r'
  limit 1;
$$;

create or replace function public.erp_pg_table_oid_map()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_object_agg(c.relname, c.oid::bigint),
    '{}'::jsonb
  )
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r';
$$;

revoke all on function public.erp_pg_table_oid(text) from public;
revoke all on function public.erp_pg_table_oid_map() from public;
grant execute on function public.erp_pg_table_oid(text) to service_role;
grant execute on function public.erp_pg_table_oid_map() to service_role;
