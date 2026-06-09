-- ERP v4.1 step9：出貨電子發票（人工回填第一版）
-- 前提：步驟 5 shipment / sales_order 已存在
-- 在 Supabase SQL Editor 執行一次

-- ── 客戶主檔：開票常用欄位 ─────────────────────────────
alter table customer add column if not exists tax_id text;
alter table customer add column if not exists invoice_title text;
alter table customer add column if not exists invoice_email text;
alter table customer add column if not exists invoice_type_default text default 'B2B';
-- invoice_type_default: B2B | B2C

create index if not exists idx_customer_tax_id on customer (tax_id);

comment on column customer.tax_id is '統一編號（B2B）；B2C 可空白';
comment on column customer.invoice_title is '發票抬頭；空白時用 customer_name';
comment on column customer.invoice_type_default is '預設 B2B 或 B2C';

-- ── 出貨主檔：發票摘要（一張出貨 ↔ 一張發票）────────────
alter table shipment add column if not exists einvoice_status text default 'NONE';
-- NONE | PENDING | ISSUED | VOID | ALLOWANCE

alter table shipment add column if not exists einvoice_type text;
-- B2B | B2C

alter table shipment add column if not exists einvoice_no text;
alter table shipment add column if not exists einvoice_date date;

alter table shipment add column if not exists einvoice_tax_id text;
alter table shipment add column if not exists einvoice_buyer_name text;
alter table shipment add column if not exists einvoice_buyer_email text;

alter table shipment add column if not exists einvoice_amount numeric default 0;
alter table shipment add column if not exists einvoice_tax_amount numeric default 0;

-- B2C 專用（B2B 可空白）
alter table shipment add column if not exists einvoice_random_code text;
alter table shipment add column if not exists einvoice_carrier_type text;
-- 例：MOBILE_BARCODE | CITIZEN_CERT | PAPER | DONATE | NONE
alter table shipment add column if not exists einvoice_carrier_id text;
alter table shipment add column if not exists einvoice_donate_code text;

alter table shipment add column if not exists einvoice_remark text;
alter table shipment add column if not exists einvoice_issued_by text;
alter table shipment add column if not exists einvoice_issued_at timestamptz;

-- 預留 API（第一版人工可不填）
alter table shipment add column if not exists einvoice_platform text;
alter table shipment add column if not exists einvoice_platform_ref text;

create index if not exists idx_shipment_einvoice_no on shipment (einvoice_no);
create index if not exists idx_shipment_einvoice_status on shipment (einvoice_status);

-- ── 發票明細（開票當下快照）────────────────────────────
create table if not exists einvoice_line (
  einvoice_line_id text primary key,
  shipment_id text not null references shipment (shipment_id) on delete restrict,
  einvoice_no text,
  line_no integer not null default 1,
  shipment_item_id text,
  so_item_id text,
  product_id text,
  description text,
  qty numeric default 0,
  unit text,
  unit_price numeric default 0,
  amount numeric default 0,
  tax_type text default 'TAXABLE',
  -- TAXABLE | ZERO | EXEMPT
  tax_rate numeric default 0.05,
  tax_amount numeric default 0,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);

create index if not exists idx_einvoice_line_ship on einvoice_line (shipment_id);
create index if not exists idx_einvoice_line_no on einvoice_line (einvoice_no);

alter table einvoice_line enable row level security;
