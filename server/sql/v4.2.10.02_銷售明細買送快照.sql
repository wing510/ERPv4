-- ERP v4.2.10 步驟 2：銷售明細 — 買 N 送 M 方案件數快照

alter table sales_order_item add column if not exists promo_buy_qty numeric;
alter table sales_order_item add column if not exists promo_scheme_free_qty numeric;

comment on column sales_order_item.promo_buy_qty is '建單當下買N（快照）';
comment on column sales_order_item.promo_scheme_free_qty is '建單當下送M（快照，方案贈送件數）';
