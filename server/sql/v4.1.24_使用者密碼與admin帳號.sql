-- v4.1.24：erp_user 密碼雜湊 + 預設可見管理員 admin（Users + 公司設定）
-- 超管僅 .env（ERP_SUPER_ADMIN_*），不寫入此表

alter table erp_user add column if not exists password_hash text;

-- 預設 admin / admin（SHA256）；上線後請於 Users 重設密碼
insert into erp_user (
  user_id, user_name, email, role, status, allowed_modules, password_hash,
  remark, created_by, updated_by, created_at, updated_at
) values (
  'admin',
  '系統管理員',
  'admin@local',
  'GA',
  'ACTIVE',
  'company_settings',
  '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918',
  '帳密登入；僅 Users 與公司設定',
  'system',
  'system',
  now(),
  now()
)
on conflict (user_id) do update set
  user_name = excluded.user_name,
  role = excluded.role,
  status = excluded.status,
  allowed_modules = excluded.allowed_modules,
  password_hash = coalesce(erp_user.password_hash, excluded.password_hash),
  remark = excluded.remark,
  updated_at = now();
