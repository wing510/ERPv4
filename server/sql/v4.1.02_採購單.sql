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
