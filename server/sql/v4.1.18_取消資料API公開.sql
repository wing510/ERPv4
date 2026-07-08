-- =============================================================================
-- 檔名：v4.1.18_取消資料API公開.sql
-- 取消 public 表對 Data API 的公開（Table Editor 列表旁不出現地球圖示）
-- 適用：ERP v4.1+（Node 後端用 service_role，不依賴 anon/authenticated）
-- 用法：Supabase SQL Editor → 全選貼上 → Run（勿只選一段；DEV / PROD 各跑一次）
-- 注意：勿 REVOKE service_role（Node 後端仍須經 PostgREST 讀寫）
--
-- 地球圖示：anon 或 authenticated 對該表仍有權限時會顯示。
-- consignment_case 無地球 = 該表 revoke 已生效；其餘有地球 = 尚未收回。
-- =============================================================================

-- 1) public 下所有表：啟用 RLS
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
      'alter table public.%I enable row level security',
      r.tablename
    );
  end loop;
end $$;

-- 2) 批次收回表權限（先 PUBLIC 再 anon/authenticated，避免繼承殘留）
revoke all on all tables in schema public from public;
revoke all on all tables in schema public from anon, authenticated;

-- 3) 逐表再收一次（含 partition 子表等邊界）
do $$
declare
  r record;
begin
  for r in
    select c.relname as tablename
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
  loop
    execute format(
      'revoke all on table public.%I from public, anon, authenticated',
      r.tablename
    );
  end loop;
end $$;

-- 4) 序列
revoke all on all sequences in schema public from public;
revoke all on all sequences in schema public from anon, authenticated;

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
      'revoke all on sequence public.%I from public, anon, authenticated',
      r.sequence_name
    );
  end loop;
end $$;

-- 5) schema 層級（anon/authenticated 不應能 usage public）
revoke all on schema public from anon, authenticated;

-- 6) 之後 postgres 新建的表：預設不 grant 給 anon / authenticated
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated;

-- 6b) supabase_admin 的 default privileges 需更高權限；略過不影響既有表 revoke
do $$
begin
  alter default privileges for role supabase_admin in schema public
    revoke all on tables from public, anon, authenticated;
  alter default privileges for role supabase_admin in schema public
    revoke all on sequences from public, anon, authenticated;
exception
  when insufficient_privilege then
    raise notice '略過 supabase_admin default privileges（不影響既有表）';
end $$;

-- 7) 驗收：應 0 列。有列 = 該表仍對 Data API 暴露（地球會出現）
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  string_agg(
    distinct case acl.grantee
      when 0 then 'PUBLIC'
      else acl.grantee::regrole::text
    end,
    ', '
    order by case acl.grantee
      when 0 then 'PUBLIC'
      else acl.grantee::regrole::text
    end
  ) as still_granted_to
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join lateral aclexplode(coalesce(c.relacl, acldefault('r', n.oid))) acl on true
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
  and (
    acl.grantee = 0
    or acl.grantee::regrole::text in ('anon', 'authenticated')
  )
group by c.relname, c.relrowsecurity
order by c.relname;
