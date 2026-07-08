-- v4.2.9.03：月結統計（寄賣＋一般請款淨額；寄賣部分寫入累積採購）
create table if not exists commercial_dealer_monthly_stat (
  stat_id text primary key,
  customer_id text not null,
  period_ym text not null,
  cumulative_scheme_id text default '',
  billing_net_consignment numeric not null default 0,
  billing_net_general numeric not null default 0,
  billing_net_total numeric not null default 0,
  gross_settlement numeric not null default 0,
  gross_shipment numeric not null default 0,
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

create index if not exists idx_cdms_customer on commercial_dealer_monthly_stat (customer_id);
create index if not exists idx_cdms_period on commercial_dealer_monthly_stat (period_ym);
create unique index if not exists uq_cdms_customer_period_active
  on commercial_dealer_monthly_stat (customer_id, period_ym)
  where (status is distinct from 'VOID');

comment on table commercial_dealer_monthly_stat is '月結統計：請款淨額快照；寄賣部分寫入累積採購（一般出貨於過帳時已累積）';

alter table commercial_dealer_monthly_stat enable row level security;
revoke all on table public.commercial_dealer_monthly_stat from anon, authenticated;
