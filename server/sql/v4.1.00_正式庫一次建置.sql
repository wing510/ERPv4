-- =============================================================================
-- ERP v4.1 正式庫一次建置（PROD bootstrap）
-- 檔名：v4.1.00_正式庫一次建置.sql
-- 目標：Supabase「ERP_DB_PROD正式」等全新空庫
-- 用法：SQL Editor → 貼上全文 → Run（1 次）
-- 建表完成後再跑：v4.1.18_取消資料API公開.sql
-- =============================================================================

-- ── 補齊：產品主檔 ─────────────────────────────────────────
create table if not exists product (
  product_id text primary key,
  product_name text,
  product_name_en text,
  hs_code text,
  type text,
  spec text,
  unit text,
  uom_config text,
  status text default 'ACTIVE',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);
create index if not exists idx_product_status on product (status);
alter table product enable row level security;

-- ── 補齊：操作紀錄 ─────────────────────────────────────────
create table if not exists logs (
  log_id text primary key,
  table_name text,
  reference_id text,
  action_type text,
  old_value text,
  new_value text,
  created_by text,
  created_at timestamptz default now()
);
create index if not exists idx_logs_created on logs (created_at desc);
create index if not exists idx_logs_table on logs (table_name);
create index if not exists idx_logs_ref on logs (reference_id);
alter table logs enable row level security;


-- ########## v4.1.01_主檔.sql ##########

-- ERP v4.1 遷移步驟 1：主檔（Supabase SQL Editor 執行，選 Run and enable RLS）

create table if not exists supplier (
  supplier_id text primary key,
  supplier_name text,
  contact_person text,
  phone text,
  email text,
  address text,
  country text,
  supplier_type text,
  supplier_flow text,
  status text default 'ACTIVE',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);

create table if not exists customer (
  customer_id text primary key,
  customer_name text,
  category text,
  contact_person text,
  phone text,
  email text,
  address text,
  country text,
  status text default 'ACTIVE',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);

create table if not exists warehouse (
  warehouse_id text primary key,
  warehouse_name text,
  category text,
  address text,
  status text default 'ACTIVE',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);

-- 勿用表名 user（PostgreSQL 保留字，Supabase 開 RLS 會語法錯誤）
create table if not exists erp_user (
  user_id text primary key,
  user_name text,
  email text,
  role text,
  status text default 'ACTIVE',
  allowed_modules text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);

create index if not exists idx_supplier_status on supplier (status);
create index if not exists idx_customer_status on customer (status);
create index if not exists idx_warehouse_status on warehouse (status);
create index if not exists idx_erp_user_email on erp_user (email);

alter table supplier enable row level security;
alter table customer enable row level security;
alter table warehouse enable row level security;
alter table erp_user enable row level security;


-- ── 客戶台灣發票欄位（不含電子發票表）────────────────────
alter table customer add column if not exists tax_id text;
alter table customer add column if not exists invoice_title text;
alter table customer add column if not exists invoice_email text;
alter table customer add column if not exists invoice_type_default text default 'B2B';
create index if not exists idx_customer_tax_id on customer (tax_id);
comment on column customer.tax_id is '統一編號（B2B）；B2C 可空白';
comment on column customer.invoice_title is '發票抬頭；空白時用 customer_name';
comment on column customer.invoice_type_default is '預設 B2B 或 B2C';


-- ########## v4.1.02_採購單.sql ##########

-- ERP v4.1 遷移步驟 2：採購單（Supabase SQL Editor → Run）

create table if not exists purchase_order (
  po_id text primary key,
  supplier_id text,
  order_date date,
  expected_arrival_date date,
  status text default 'OPEN',
  document_link text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists purchase_order_item (
  po_item_id text primary key,
  po_id text not null,
  product_id text,
  order_qty numeric default 0,
  received_qty numeric default 0,
  unit text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create index if not exists idx_po_supplier on purchase_order (supplier_id);
create index if not exists idx_po_status on purchase_order (status);
create index if not exists idx_poi_po on purchase_order_item (po_id);
create index if not exists idx_poi_product on purchase_order_item (product_id);

alter table purchase_order enable row level security;
alter table purchase_order_item enable row level security;


-- ########## v4.1.03_進口報單與收貨.sql ##########

-- ERP v4.1 遷移步驟 3：進口報單 + 收貨入庫（Supabase SQL Editor → Run）
-- 前置：product / supplier / purchase_order 等主檔與採購表（步驟 1–2）已存在

-- ── 進口報單 ─────────────────────────────────────────────
create table if not exists import_document (
  import_doc_id text primary key,
  import_no text,
  import_date date,
  release_date date,
  supplier_id text,
  inspection_no text,
  status text default 'OPEN',
  document_link text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists import_item (
  import_item_id text primary key,
  import_doc_id text not null,
  item_no text,
  product_id text,
  hs_code text,
  invoice_no text,
  origin_country text,
  declared_qty numeric default 0,
  declared_unit text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists import_receipt (
  import_receipt_id text primary key,
  import_doc_id text not null,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  receipt_date date,
  warehouse text,
  status text default 'OPEN',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists import_receipt_item (
  import_receipt_item_id text primary key,
  import_receipt_id text not null,
  import_item_id text,
  product_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  received_qty numeric default 0,
  unit text,
  lot_id text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

-- ── 採購收貨 ─────────────────────────────────────────────
create table if not exists goods_receipt (
  gr_id text primary key,
  po_id text not null,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  receipt_date date,
  warehouse text,
  status text default 'OPEN',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists goods_receipt_item (
  gr_item_id text primary key,
  gr_id text not null,
  po_id text,
  po_item_id text,
  product_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  received_qty numeric default 0,
  unit text,
  lot_id text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

-- ── 批號 / 異動（若步驟 0 已建可略過）────────────────────
create table if not exists lot (
  lot_id text primary key,
  product_id text,
  warehouse_id text,
  source_type text,
  source_id text,
  qty numeric default 0,
  unit text,
  type text,
  status text default 'PENDING',
  inventory_status text default 'ACTIVE',
  received_date date,
  manufacture_date date,
  expiry_date date,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists inventory_movement (
  movement_id text primary key,
  movement_type text,
  lot_id text,
  product_id text,
  warehouse_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  qty numeric default 0,
  unit text,
  ref_type text,
  ref_id text,
  issued_to text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create index if not exists idx_import_doc_status on import_document (status);
create index if not exists idx_import_item_doc on import_item (import_doc_id);
create index if not exists idx_import_receipt_doc on import_receipt (import_doc_id);
create index if not exists idx_import_receipt_item_rid on import_receipt_item (import_receipt_id);
create index if not exists idx_gr_po on goods_receipt (po_id);
create index if not exists idx_gr_item_gr on goods_receipt_item (gr_id);
create index if not exists idx_lot_product on lot (product_id);
create index if not exists idx_mv_lot on inventory_movement (lot_id);

alter table import_document enable row level security;
alter table import_item enable row level security;
alter table import_receipt enable row level security;
alter table import_receipt_item enable row level security;
alter table goods_receipt enable row level security;
alter table goods_receipt_item enable row level security;
alter table lot enable row level security;
alter table inventory_movement enable row level security;


-- ########## v4.1.04_庫存快照.sql ##########

-- ERP v4.1 遷移步驟 4：庫存快照（若步驟 0 已建可略過）

create table if not exists lot_balance (
  lot_id text primary key,
  available_qty numeric default 0,
  movement_count integer default 0,
  last_movement_id text,
  updated_at timestamptz default now(),
  updated_by text
);

create index if not exists idx_lot_balance_updated on lot_balance (updated_at);

alter table lot_balance enable row level security;


-- ########## v4.1.05_銷售與出貨.sql ##########

-- ERP v4.1 遷移步驟 5：銷售單 + 出貨（Supabase SQL Editor → Run）
-- 前置：customer / product / lot / inventory_movement（步驟 1、3、4）已存在

-- ── 銷售單 ─────────────────────────────────────────────
create table if not exists sales_order (
  so_id text primary key,
  customer_id text,
  salesperson_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  so_type text default 'NORMAL',
  reship_ref_type text,
  reship_ref_id text,
  order_date date,
  status text default 'OPEN',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists sales_order_item (
  so_item_id text primary key,
  so_id text not null,
  product_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  order_qty numeric default 0,
  shipped_qty numeric default 0,
  unit text,
  unit_price numeric default 0,
  amount numeric default 0,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

-- ── 出貨單 ─────────────────────────────────────────────
create table if not exists shipment (
  shipment_id text primary key,
  so_id text not null,
  customer_id text,
  shipper_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  ship_date date,
  status text default 'POSTED',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists shipment_item (
  shipment_item_id text primary key,
  shipment_id text not null,
  so_id text,
  so_item_id text,
  lot_id text,
  product_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  ship_qty numeric default 0,
  unit text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create index if not exists idx_so_customer on sales_order (customer_id);
create index if not exists idx_so_status on sales_order (status);
create index if not exists idx_so_created on sales_order (created_at);
create index if not exists idx_soi_so on sales_order_item (so_id);
create index if not exists idx_soi_product on sales_order_item (product_id);

create index if not exists idx_ship_so on shipment (so_id);
create index if not exists idx_ship_status on shipment (status);
create index if not exists idx_ship_created on shipment (created_at);
create index if not exists idx_shi_ship on shipment_item (shipment_id);
create index if not exists idx_shi_so on shipment_item (so_id);
create index if not exists idx_shi_lot on shipment_item (lot_id);

alter table sales_order enable row level security;
alter table sales_order_item enable row level security;
alter table shipment enable row level security;
alter table shipment_item enable row level security;


-- ########## v4.1.06_委外加工.sql ##########

-- ERP v4.1 遷移步驟 6：委外加工（Supabase SQL Editor → Run）
-- 前置：supplier / product / lot / inventory_movement（步驟 1、3、4）已存在

create table if not exists process_order (
  process_order_id text primary key,
  process_type text,
  source_type text,
  supplier_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  planned_date date,
  status text default 'OPEN',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists process_order_input (
  process_input_id text primary key,
  process_order_id text not null,
  lot_id text,
  product_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  issue_qty numeric default 0,
  unit text,
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists process_order_output (
  process_output_id text primary key,
  process_order_id text not null,
  lot_id text,
  product_id text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  receive_qty numeric default 0,
  unit text,
  loss_base_qty_after numeric,
  loss_base_unit text,
  status text default 'CREATED',
  remark text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create table if not exists lot_relation (
  relation_id text primary key,
  relation_type text,
  from_lot_id text,
  to_lot_id text,
  qty numeric default 0,
  unit text,
  transaction_id text,
  parent_ref_type text,
  parent_ref_id text,
  ref_type text,
  ref_id text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz,
  system_remark text
);

create index if not exists idx_proc_supplier on process_order (supplier_id);
create index if not exists idx_proc_status on process_order (status);
create index if not exists idx_proc_created on process_order (created_at);
create index if not exists idx_poi_proc on process_order_input (process_order_id);
create index if not exists idx_poi_lot on process_order_input (lot_id);
create index if not exists idx_poo_proc on process_order_output (process_order_id);
create index if not exists idx_poo_lot on process_order_output (lot_id);
create index if not exists idx_rel_from on lot_relation (from_lot_id);
create index if not exists idx_rel_to on lot_relation (to_lot_id);
create index if not exists idx_rel_ref on lot_relation (ref_type, ref_id);

alter table process_order enable row level security;
alter table process_order_input enable row level security;
alter table process_order_output enable row level security;
alter table lot_relation enable row level security;


-- ########## v4.1.08_Supabase表編輯RPC.sql ##########

-- v4.1 step8：供 ERP 前端「Supabase」按鈕解析 Table Editor 連結
-- 在 Supabase SQL Editor 執行一次即可

create or replace function public.erp_pg_table_oid(p_table text)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select c.oid::bigint
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = lower(trim(p_table))
    and c.relkind = 'r'
  limit 1;
$$;

create or replace function public.erp_pg_table_oid_map()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_object_agg(c.relname, c.oid::bigint),
    '{}'::jsonb
  )
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r';
$$;

revoke all on function public.erp_pg_table_oid(text) from public;
revoke all on function public.erp_pg_table_oid_map() from public;
grant execute on function public.erp_pg_table_oid(text) to service_role;
grant execute on function public.erp_pg_table_oid_map() to service_role;


-- ########## v4.1.10_商業發票.sql ##########

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


-- ########## v4.1.11_公司資料中文.sql ##########

-- ERP v4.1 step11：公司資料中英欄位（erp_company_profile）
-- 在 Supabase SQL Editor 執行一次（step10 已跑過亦可）

alter table erp_company_profile add column if not exists company_name_zh text;
alter table erp_company_profile add column if not exists address_zh text;
alter table erp_company_profile add column if not exists city_zh text;
alter table erp_company_profile add column if not exists country_zh text default '台灣';

comment on column erp_company_profile.company_name_zh is '公司名稱（中文）';
comment on column erp_company_profile.address_zh is '地址（中文）';
comment on column erp_company_profile.city_zh is '城市（中文）';
comment on column erp_company_profile.country_zh is '國家（中文）';


-- ########## v4.1.12_公司章.sql ##########

-- ERP v4.1 step12：公司章（Commercial Invoice 列印簽章用）
-- 在 Supabase SQL Editor 執行一次

alter table erp_company_profile add column if not exists company_seal_url text;

comment on column erp_company_profile.company_seal_url is '公司章圖片 URL 或 data:image/... Base64（CI PDF 簽章區）';


-- ########## v4.1.13_買方USCI.sql ##########

-- v4.1 step13：Commercial Invoice 買方 USCI（統一社會信用代碼）

alter table customer add column if not exists consignee_usci text;
comment on column customer.consignee_usci is '統一社會信用代碼 USCI（大陸企業清關）';

alter table commercial_invoice add column if not exists buyer_usci text;
comment on column commercial_invoice.buyer_usci is '買方 USCI（統一社會信用代碼）';


-- ########## v4.1.14_客戶類型.sql ##########

-- v4.1 step14：客戶類型（個人 / 公司）

alter table customer add column if not exists customer_type text default 'COMPANY';
comment on column customer.customer_type is 'PERSON=個人, COMPANY=公司（預設）';

update customer set customer_type = 'COMPANY' where customer_type is null or trim(customer_type) = '';


-- ########## v4.1.15_銷售單幣別.sql ##########

-- ERP v4.1 遷移步驟 15：銷售單幣別（Supabase SQL Editor → Run）
-- 前置：sales_order（步驟 5）已存在

alter table sales_order
  add column if not exists currency text;

comment on column sales_order.currency is '銷售幣別：USD / TWD / CNY / EUR';


-- ########## v4.1.17_HS稅則號.sql ##########

-- ERP v4.1 step17：產品稅則號 + CI 明細快照（PDF HS Code 欄）
-- 在 Supabase SQL Editor 執行一次

alter table product add column if not exists hs_code text;
comment on column product.hs_code is '稅則號（HS Code）；Commercial Invoice PDF 選用欄位';

alter table commercial_invoice_line add column if not exists hs_code text;
comment on column commercial_invoice_line.hs_code is '稅則號快照（開立 CI 時自產品帶入）';

