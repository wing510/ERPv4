-- ERP v4.1 遷移步驟 15：銷售單幣別（Supabase SQL Editor → Run）
-- 前置：sales_order（步驟 5）已存在

alter table sales_order
  add column if not exists currency text;

comment on column sales_order.currency is '銷售幣別：USD / TWD / CNY / EUR';
