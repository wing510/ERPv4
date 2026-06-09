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
