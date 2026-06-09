-- ERP v4.1 step10：英文商業發票（Commercial Invoice）
-- 前提：step5 shipment 已存在
-- 在 Supabase SQL Editor 執行一次

-- ── 公司英文資料（賣方 / Shipper）────────────────────────
create table if not exists erp_company_profile (
  profile_id text primary key default 'DEFAULT',
  company_name_en text,
  address_en text,
  city_en text,
  country_en text default 'Taiwan',
  postal_code text,
  phone text,
  email text,
  tax_id text,
  default_currency text default 'USD',
  default_country_of_origin text default 'Taiwan',
  default_incoterms text,
  declaration_text text default 'I declare that the information is true and correct.',
  remark text,
  updated_by text,
  updated_at timestamptz
);

insert into erp_company_profile (profile_id)
values ('DEFAULT')
on conflict (profile_id) do nothing;

-- ── 客戶：出口用英文 + 收件人證號（大陸清關等）──────────
alter table customer add column if not exists invoice_name_en text;
alter table customer add column if not exists invoice_address_en text;
alter table customer add column if not exists consignee_id_no text;

comment on column customer.invoice_name_en is 'Commercial Invoice 買方英文抬頭';
comment on column customer.invoice_address_en is 'Commercial Invoice 買方英文地址';
comment on column customer.consignee_id_no is '收件人證件號（例：大陸清關）';

-- ── 產品：英文品名 ───────────────────────────────────────
alter table product add column if not exists product_name_en text;

-- ── 商業發票主檔（一張出貨 ↔ 一張 CI）──────────────────
create table if not exists commercial_invoice (
  ci_id text primary key,
  shipment_id text not null references shipment (shipment_id) on delete restrict,
  so_id text,
  ci_no text,
  ci_date date,
  status text default 'DRAFT',
  currency text default 'USD',
  incoterms text,
  waybill_no text,
  country_of_origin text default 'Taiwan',
  seller_company_name_en text,
  seller_address_en text,
  seller_phone text,
  seller_email text,
  seller_tax_id text,
  buyer_name_en text,
  buyer_address_en text,
  buyer_phone text,
  buyer_country text,
  buyer_id_no text,
  subtotal numeric default 0,
  total_amount numeric default 0,
  payment_terms text,
  remark text,
  signature_name text,
  signature_date date,
  declaration_text text,
  issued_by text,
  issued_at timestamptz,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);

create unique index if not exists idx_commercial_invoice_ship on commercial_invoice (shipment_id);
create index if not exists idx_commercial_invoice_no on commercial_invoice (ci_no);
create index if not exists idx_commercial_invoice_status on commercial_invoice (status);

-- ── 商業發票明細 ─────────────────────────────────────────
create table if not exists commercial_invoice_line (
  ci_line_id text primary key,
  ci_id text not null references commercial_invoice (ci_id) on delete cascade,
  line_no integer not null default 1,
  shipment_item_id text,
  so_item_id text,
  product_id text,
  description_en text,
  qty numeric default 0,
  unit text,
  unit_price numeric default 0,
  amount numeric default 0,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);

create index if not exists idx_ci_line_ci on commercial_invoice_line (ci_id);

alter table erp_company_profile enable row level security;
alter table commercial_invoice enable row level security;
alter table commercial_invoice_line enable row level security;
