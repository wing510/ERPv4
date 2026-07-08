-- v4.2.9.02：一般出貨過帳寫入累積採購快照（避免與月結回饋重複計入）
alter table ar_receivable add column if not exists dealer_cumulative_added numeric not null default 0;

comment on column ar_receivable.dealer_cumulative_added is '本筆一般出貨已加入累積採購（=請款淨額 amount_system）';
