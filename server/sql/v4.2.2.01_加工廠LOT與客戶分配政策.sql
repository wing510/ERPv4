-- ERP v4.2.2 遷移步驟 1：加工廠 Lot + 客戶預設分配政策（Supabase SQL Editor → Run）
-- 前置：v4.2.2.00 寄賣案件表已存在；lot、customer 主檔已存在

-- 批號主檔：加工廠 Lot（標籤批號）
alter table lot
  add column if not exists factory_lot text;

create index if not exists idx_lot_factory_lot on lot (factory_lot);

comment on column lot.factory_lot is '加工廠 Lot（標籤批號；與 lot_id 系統批號並存）';

-- 客戶主檔：寄賣收回預設分配政策（開案時帶入，案件可改）
alter table customer
  add column if not exists consignment_allocation_policy text default 'FIFO';

comment on column customer.consignment_allocation_policy is '寄賣收回預設：FIFO／HIGH_PRICE_FIRST／PRICE_IF_GIVEN';
