-- ERP v4.2.15：SO Pricing Snapshot + Shipment Promotion Snapshot（Phase 1）
-- Supabase SQL Editor → Run
-- 前置：sales_order_item / shipment_item 已存在

-- ── SO 明細計價快照（append-only；immutable identity）──────────
create table if not exists so_item_pricing_snapshot (
  pricing_snapshot_id text primary key,
  so_item_id text not null,
  so_id text not null,
  pricing_version integer not null,
  dealer_tier_label text default '',
  dealer_price_rate numeric,
  dealer_price_source text default '',
  base_price_basis text default 'DEALER',
  list_unit_price numeric default 0,
  base_unit_price numeric default 0,
  pricing_engine_version text not null default 'SO_PRICING_ENGINE_V1',
  snapshot_ts timestamptz not null default now(),
  created_by text,
  created_at timestamptz not null default now(),
  constraint so_item_pricing_snapshot_version_chk check (pricing_version >= 1)
);

create unique index if not exists idx_soips_item_version
  on so_item_pricing_snapshot (so_item_id, pricing_version);

create index if not exists idx_soips_so on so_item_pricing_snapshot (so_id);
create index if not exists idx_soips_item on so_item_pricing_snapshot (so_item_id);

comment on table so_item_pricing_snapshot is
  'Phase1：SO Save 產生之 dealer/base 計價快照；已被出貨引用之 version 不可覆寫';
comment on column so_item_pricing_snapshot.pricing_snapshot_id is 'immutable snapshot id';
comment on column so_item_pricing_snapshot.pricing_version is '同 so_item_id 遞增版本';
comment on column so_item_pricing_snapshot.base_price_basis is 'LIST／DEALER';
comment on column so_item_pricing_snapshot.base_unit_price is 'Server 權威底價（已含經銷折數或牌價）';

alter table so_item_pricing_snapshot enable row level security;
revoke all on table public.so_item_pricing_snapshot from anon, authenticated;

-- ── sales_order_item：指向目前 current snapshot ────────────────
alter table sales_order_item add column if not exists pricing_snapshot_id text;
alter table sales_order_item add column if not exists pricing_version integer;

comment on column sales_order_item.pricing_snapshot_id is '目前 SO Pricing Snapshot id（Save 後更新）';
comment on column sales_order_item.pricing_version is '目前 SO Pricing Snapshot version';

-- ── shipment_item：引用 SO snapshot + 本批 promotion result ─────
alter table shipment_item add column if not exists so_pricing_snapshot_id text;
alter table shipment_item add column if not exists so_pricing_version integer;
alter table shipment_item add column if not exists shipment_pricing_unit_price numeric;
alter table shipment_item add column if not exists shipment_pricing_billable_qty numeric;
alter table shipment_item add column if not exists shipment_pricing_free_qty numeric;
alter table shipment_item add column if not exists shipment_pricing_amount numeric;
alter table shipment_item add column if not exists applied_promo_scheme_id text default '';
alter table shipment_item add column if not exists applied_promo_type text default '';
alter table shipment_item add column if not exists applied_promo_scope text default '';

comment on column shipment_item.so_pricing_snapshot_id is '引用之 SO Pricing Snapshot（不可因後續 SO Save 改寫）';
comment on column shipment_item.so_pricing_version is '引用之 SO Pricing Snapshot version';
comment on column shipment_item.shipment_pricing_unit_price is '本批 Shipment Promotion Snapshot 單價';
comment on column shipment_item.shipment_pricing_billable_qty is '本批計價數量（買送後）';
comment on column shipment_item.shipment_pricing_free_qty is '本批贈送數量';
comment on column shipment_item.shipment_pricing_amount is '本批金額；AR.amount_system 加總來源';
comment on column shipment_item.applied_promo_scope is 'PER_SHIPMENT（三種 promo_type 同權威）';

create index if not exists idx_shi_so_pricing_snap on shipment_item (so_pricing_snapshot_id);
