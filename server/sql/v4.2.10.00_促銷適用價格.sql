-- ERP v4.2.10 步驟 0：Promo 促銷方案 — 適用價格（牌價／經銷價）

alter table consignment_promo_scheme add column if not exists price_basis text not null default 'DEALER';

comment on column consignment_promo_scheme.price_basis is 'DEALER 經銷價（預設）／LIST 牌價（建議售價）';

update consignment_promo_scheme
set price_basis = 'DEALER'
where coalesce(trim(price_basis), '') = '';
