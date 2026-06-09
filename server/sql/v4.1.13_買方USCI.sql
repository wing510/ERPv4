-- v4.1 step13：Commercial Invoice 買方 USCI（統一社會信用代碼）

alter table customer add column if not exists consignee_usci text;
comment on column customer.consignee_usci is '統一社會信用代碼 USCI（大陸企業清關）';

alter table commercial_invoice add column if not exists buyer_usci text;
comment on column commercial_invoice.buyer_usci is '買方 USCI（統一社會信用代碼）';
