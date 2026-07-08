-- ERP v4.2.9 步驟 0：Promo 促銷方案 — 適用管道（寄賣／一般／全部）

alter table consignment_promo_scheme add column if not exists channel text not null default 'CONSIGNMENT';

comment on column consignment_promo_scheme.channel is 'CONSIGNMENT 寄賣／GENERAL 一般銷售／ALL 全部';

update consignment_promo_scheme
set channel = 'CONSIGNMENT'
where coalesce(trim(channel), '') = '';
