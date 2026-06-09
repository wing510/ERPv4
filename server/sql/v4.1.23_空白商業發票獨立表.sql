-- =============================================================================
-- 檔名：v4.1.23_空白商業發票獨立表.sql
-- 空白 Commercial Invoice 使用獨立表（與出貨單 CI 分開）
-- 若曾跑 v4.1.22：會搬移 standalone 資料並還原 commercial_invoice
-- 用法：Supabase SQL Editor → Run（DEV / PROD 各跑一次）
-- =============================================================================

-- ── 空白 CI 主檔 ─────────────────────────────────────────
create table if not exists commercial_invoice_blank (
  ci_id text primary key,
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
  buyer_usci text,
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

create unique index if not exists idx_commercial_invoice_blank_no on commercial_invoice_blank (ci_no);
create index if not exists idx_commercial_invoice_blank_status on commercial_invoice_blank (status);

-- ── 空白 CI 明細 ─────────────────────────────────────────
create table if not exists commercial_invoice_blank_line (
  ci_line_id text primary key,
  ci_id text not null references commercial_invoice_blank (ci_id) on delete cascade,
  line_no integer not null default 1,
  product_id text,
  description_en text,
  hs_code text,
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

create index if not exists idx_ci_blank_line_ci on commercial_invoice_blank_line (ci_id);

alter table commercial_invoice_blank enable row level security;
alter table commercial_invoice_blank_line enable row level security;

-- ── 若曾跑 v4.1.22：搬移後刪除 commercial_invoice 內 standalone 列 ──
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'commercial_invoice' and column_name = 'source_type'
  ) then
    insert into commercial_invoice_blank (
      ci_id, ci_no, ci_date, status, currency, incoterms, waybill_no, country_of_origin,
      seller_company_name_en, seller_address_en, seller_phone, seller_email, seller_tax_id,
      buyer_name_en, buyer_address_en, buyer_phone, buyer_country, buyer_id_no, buyer_usci,
      subtotal, total_amount, payment_terms, remark, signature_name, signature_date,
      declaration_text, issued_by, issued_at, created_by, created_at, updated_by, updated_at
    )
    select
      ci_id, ci_no, ci_date, status, currency, incoterms, waybill_no, country_of_origin,
      seller_company_name_en, seller_address_en, seller_phone, seller_email, seller_tax_id,
      buyer_name_en, buyer_address_en, buyer_phone, buyer_country, buyer_id_no, buyer_usci,
      subtotal, total_amount, payment_terms, remark, signature_name, signature_date,
      declaration_text, issued_by, issued_at, created_by, created_at, updated_by, updated_at
    from commercial_invoice ci
    where (ci.shipment_id is null or trim(ci.shipment_id) = '')
       or coalesce(ci.source_type, '') = 'STANDALONE'
    on conflict (ci_id) do nothing;

    insert into commercial_invoice_blank_line (
      ci_line_id, ci_id, line_no, product_id, description_en, hs_code,
      qty, unit, unit_price, amount, remark, created_by, created_at, updated_by, updated_at
    )
    select
      l.ci_line_id, l.ci_id, l.line_no, l.product_id, l.description_en, l.hs_code,
      l.qty, l.unit, l.unit_price, l.amount, l.remark, l.created_by, l.created_at, l.updated_by, l.updated_at
    from commercial_invoice_line l
    inner join commercial_invoice ci on ci.ci_id = l.ci_id
    where (ci.shipment_id is null or trim(ci.shipment_id) = '')
       or coalesce(ci.source_type, '') = 'STANDALONE'
    on conflict (ci_line_id) do nothing;

    delete from commercial_invoice_line l
    using commercial_invoice ci
    where l.ci_id = ci.ci_id
      and ((ci.shipment_id is null or trim(ci.shipment_id) = '')
        or coalesce(ci.source_type, '') = 'STANDALONE');

    delete from commercial_invoice ci
    where (ci.shipment_id is null or trim(ci.shipment_id) = '')
       or coalesce(ci.source_type, '') = 'STANDALONE';

    alter table commercial_invoice drop column if exists source_type;
    drop index if exists idx_commercial_invoice_source;
  end if;
end $$;

-- 還原出貨 CI：shipment_id 必填 + FK（僅當無空值列）
do $$
begin
  if not exists (
    select 1 from commercial_invoice where shipment_id is null or trim(shipment_id) = ''
  ) then
    alter table commercial_invoice alter column shipment_id set not null;
    alter table commercial_invoice drop constraint if exists commercial_invoice_shipment_id_fkey;
    alter table commercial_invoice
      add constraint commercial_invoice_shipment_id_fkey
      foreign key (shipment_id) references shipment (shipment_id) on delete restrict;
    drop index if exists idx_commercial_invoice_ship;
    create unique index if not exists idx_commercial_invoice_ship on commercial_invoice (shipment_id);
  end if;
end $$;
