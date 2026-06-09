-- =============================================================================
-- 檔名：v4.1.22_空白商業發票.sql
-- 【已廢止】請改跑 v4.1.23_空白商業發票獨立表.sql（空白 CI 用獨立表）
-- 若已執行本檔：仍請再跑 v4.1.23，會自動搬移資料並還原 commercial_invoice
-- =============================================================================

alter table commercial_invoice drop constraint if exists commercial_invoice_shipment_id_fkey;

alter table commercial_invoice alter column shipment_id drop not null;

alter table commercial_invoice add column if not exists source_type text default 'SHIPMENT';
comment on column commercial_invoice.source_type is 'SHIPMENT=連出貨單；STANDALONE=空白開立';

update commercial_invoice
set source_type = 'SHIPMENT'
where source_type is null or trim(source_type) = '';

update commercial_invoice
set source_type = 'STANDALONE'
where (shipment_id is null or trim(shipment_id) = '')
  and coalesce(source_type, '') <> 'STANDALONE';

drop index if exists idx_commercial_invoice_ship;

create unique index if not exists idx_commercial_invoice_ship
  on commercial_invoice (shipment_id)
  where shipment_id is not null and trim(shipment_id) <> '';

create index if not exists idx_commercial_invoice_source on commercial_invoice (source_type);
