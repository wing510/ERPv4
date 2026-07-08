-- ERP v4.2.3 遷移步驟 1：結算明細促銷快照（結算當下寫入，歷史不依方案表回溯）
-- 前置：v4.2.3.00 已執行

alter table consignment_case_settlement_item
  add column if not exists promo_scheme_name text;
alter table consignment_case_settlement_item
  add column if not exists promo_discount_pct numeric;
alter table consignment_case_settlement_item
  add column if not exists promo_buy_qty numeric;
alter table consignment_case_settlement_item
  add column if not exists promo_scheme_free_qty numeric;

comment on column consignment_case_settlement_item.promo_scheme_name is '結算當下促銷方案名稱（快照）';
comment on column consignment_case_settlement_item.promo_discount_pct is '結算當下折扣％（快照）';
comment on column consignment_case_settlement_item.promo_buy_qty is '結算當下買N（快照）';
comment on column consignment_case_settlement_item.promo_scheme_free_qty is '結算當下送M（快照，方案贈送件數）';
