-- v4.2.12：經銷等級過帳（第二步；須月結統計已過帳）
create table if not exists commercial_dealer_level_post (
  level_post_id text primary key,
  stat_id text not null default '',
  customer_id text not null,
  period_ym text not null,
  cumulative_scheme_id text default '',
  billing_net_consignment numeric not null default 0,
  billing_net_general numeric not null default 0,
  billing_net_total numeric not null default 0,
  cumulative_add_consignment numeric not null default 0,
  cumulative_add_general numeric not null default 0,
  cumulative_before numeric,
  cumulative_after numeric,
  cumulative_pending_tier_label text default '',
  cumulative_pending_price_rate numeric,
  cumulative_pending_from_ym text default '',
  status text not null default 'POSTED',
  remark text default '',
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  void_reason text default '',
  system_remark text default ''
);

create index if not exists idx_cdlp_customer on commercial_dealer_level_post (customer_id);
create index if not exists idx_cdlp_period on commercial_dealer_level_post (period_ym);
create index if not exists idx_cdlp_stat on commercial_dealer_level_post (stat_id);
create unique index if not exists uq_cdlp_customer_period_active
  on commercial_dealer_level_post (customer_id, period_ym)
  where (status is distinct from 'VOID');

comment on table commercial_dealer_level_post is '經銷等級過帳：依月結統計快照寫入累積；v4.2.12 與月結統計分離';

alter table commercial_dealer_level_post enable row level security;
revoke all on table public.commercial_dealer_level_post from anon, authenticated;
