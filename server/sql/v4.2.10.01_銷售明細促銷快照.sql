-- ERP v4.2.10 步驟 1：銷售明細 — 一般銷售促銷快照

alter table sales_order_item add column if not exists billable_qty numeric;
alter table sales_order_item add column if not exists free_qty numeric default 0;
alter table sales_order_item add column if not exists promo_scheme_id text default '';
alter table sales_order_item add column if not exists promo_scheme_name text default '';
alter table sales_order_item add column if not exists promo_type text default '';
alter table sales_order_item add column if not exists promo_price_basis text default '';
alter table sales_order_item add column if not exists base_unit_price numeric;

comment on column sales_order_item.billable_qty is '計價數量（買送後；無促銷＝訂購數量）';
comment on column sales_order_item.free_qty is '贈送數量（買N送M）';
comment on column sales_order_item.promo_scheme_id is '建單當下促銷方案快照';
comment on column sales_order_item.promo_scheme_name is '建單當下促銷方案名稱快照';
comment on column sales_order_item.promo_type is 'FIXED_PRICE／DISCOUNT_PCT／BUY_N_GET_M';
comment on column sales_order_item.promo_price_basis is 'DEALER／LIST';
comment on column sales_order_item.base_unit_price is '促銷計價底價（牌價或經銷價）';
