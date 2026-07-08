-- v4.2.9.04：累積制升級次月生效（認定月份）
alter table customer add column if not exists dealer_cumulative_pending_from_ym text default '';

comment on column customer.dealer_cumulative_pending_from_ym is '累積升級認定月 YYYY-MM；結算／出貨月份嚴格大於此月才套用待生效等級';
