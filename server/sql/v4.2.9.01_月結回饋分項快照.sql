-- ERP v4.2.9 步驟 1：月結回饋 — 寄賣／一般請款淨額分項快照

alter table commercial_dealer_rebate add column if not exists billing_net_consignment numeric;
alter table commercial_dealer_rebate add column if not exists billing_net_general numeric;
alter table commercial_dealer_rebate add column if not exists gross_settlement numeric;
alter table commercial_dealer_rebate add column if not exists gross_shipment numeric;

comment on column commercial_dealer_rebate.billing_net_consignment is '產生時：寄賣結算請款淨額';
comment on column commercial_dealer_rebate.billing_net_general is '產生時：一般出貨請款淨額';
comment on column commercial_dealer_rebate.gross_settlement is '產生時：寄賣結算毛額';
comment on column commercial_dealer_rebate.gross_shipment is '產生時：一般出貨毛額';
