-- ERP v4.3.2：一般出貨過帳 Phase1 單一 DB transaction（Supabase SQL Editor → Run）
-- 前置：v4.3.1_銷售與出貨計價快照.sql、inventory_movement / lot_balance 已存在
-- 建議：v4.2.2.03 已執行（erp_lot_available_qty / erp_new_movement_id）；未執行時本檔會一併建立
-- 用途：NORMAL 一般出貨 POST 原子寫入（shipment / shipment_item 計價快照 / 庫存 / SO / AR）
-- 計價仍由 Node buildShipmentArPricing_ 權威計算後傳入 p_pricing_lines（parity）；寫入在單一 transaction

-- ── 工具（與 v4.2.2.03 相容）────────────────────────────────────
create or replace function public.erp_norm_id(p_text text)
returns text
language sql
immutable
as $$
  select upper(trim(coalesce(p_text, '')));
$$;

create or replace function public.erp_new_movement_id()
returns text
language sql
as $$
  select 'MV-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' ||
         upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4));
$$;

create or replace function public.erp_lot_available_qty(p_lot_id text)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select lb.available_qty from lot_balance lb where lb.lot_id = p_lot_id),
    (select sum(m.qty) from inventory_movement m where m.lot_id = p_lot_id),
    0::numeric
  );
$$;

create or replace function public.erp_calc_so_status(p_so_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total int := 0;
  v_all_shipped int := 0;
  v_any_shipped int := 0;
  r record;
begin
  for r in
    select order_qty, shipped_qty from sales_order_item where so_id = erp_norm_id(p_so_id)
  loop
    v_total := v_total + 1;
    if coalesce(r.shipped_qty, 0) + 1e-9 >= coalesce(r.order_qty, 0) and coalesce(r.order_qty, 0) > 0 then
      v_all_shipped := v_all_shipped + 1;
    end if;
    if coalesce(r.shipped_qty, 0) > 1e-9 then
      v_any_shipped := v_any_shipped + 1;
    end if;
  end loop;
  if v_total = 0 then return 'OPEN'; end if;
  if v_all_shipped = v_total then return 'SHIPPED'; end if;
  if v_any_shipped > 0 then return 'PARTIAL'; end if;
  return 'OPEN';
end;
$$;

-- ── Phase1 一般出貨過帳（原子）──────────────────────────────────
create or replace function public.erp_ship_post_phase1_tx(
  p_shipment_id text,
  p_so_id text,
  p_customer_id text,
  p_ship_date date,
  p_shipper_id text,
  p_recipient_id text,
  p_recipient_name text,
  p_recipient_name_en text,
  p_recipient_address text,
  p_recipient_phone text,
  p_transaction_id text,
  p_parent_ref_type text,
  p_parent_ref_id text,
  p_remark text,
  p_items_json jsonb,
  p_pricing_lines jsonb,
  p_amount_system numeric,
  p_currency text,
  p_system_remark text,
  p_actor text default '',
  p_ts timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sid text := erp_norm_id(p_shipment_id);
  v_so_id text := erp_norm_id(p_so_id);
  v_cust text := erp_norm_id(p_customer_id);
  v_actor text := trim(coalesce(p_actor, ''));
  v_tx text := trim(coalesce(p_transaction_id, ''));
  v_parent_type text := upper(trim(coalesce(p_parent_ref_type, 'SO')));
  v_parent_id text := erp_norm_id(p_parent_ref_id);
  v_existed record;
  v_so record;
  v_item jsonb;
  v_i int;
  v_lot_id text;
  v_qty numeric;
  v_so_item_id text;
  v_shi_id text;
  v_so_item record;
  v_lot record;
  v_product_id text;
  v_mv_id text;
  v_avail numeric;
  v_demand numeric;
  v_delta jsonb := '{}'::jsonb;
  v_lot_demand jsonb := '{}'::jsonb;
  v_lot_keys text[];
  v_key text;
  v_next_shipped numeric;
  v_remain numeric;
  v_line jsonb;
  v_ar_id text;
  v_currency text := upper(trim(coalesce(p_currency, 'TWD')));
  v_amount numeric := round(coalesce(p_amount_system, 0)::numeric, 2);
begin
  if v_sid = '' then raise exception 'ERR_SHIPMENT_ID_REQUIRED'; end if;
  if v_so_id = '' then raise exception 'ERR_SO_ID_REQUIRED'; end if;
  if v_cust = '' then raise exception 'ERR_CUSTOMER_ID_REQUIRED'; end if;
  if p_ship_date is null then raise exception 'ERR_SHIP_DATE_REQUIRED'; end if;
  if trim(coalesce(p_shipper_id, '')) = '' then raise exception 'ERR_SHIPPER_REQUIRED'; end if;
  if erp_norm_id(p_recipient_id) = '' then raise exception 'ERR_RECIPIENT_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;
  if v_tx = '' then raise exception 'ERR_TRANSACTION_ID_REQUIRED'; end if;
  if trim(coalesce(p_recipient_name, '')) = '' and trim(coalesce(p_recipient_name_en, '')) = '' then
    raise exception 'ERR_RECIPIENT_NAME_REQUIRED';
  end if;
  if p_items_json is null or jsonb_typeof(p_items_json) <> 'array' or jsonb_array_length(p_items_json) < 1 then
    raise exception 'ERR_ITEMS_REQUIRED';
  end if;
  if p_pricing_lines is null or jsonb_typeof(p_pricing_lines) <> 'array' then
    raise exception 'ERR_PRICING_LINES_REQUIRED';
  end if;

  select * into v_existed from shipment where shipment_id = v_sid;
  if found then
    if upper(trim(coalesce(v_existed.status, ''))) = 'POSTED'
       and trim(coalesce(v_existed.transaction_id, '')) = v_tx then
      return jsonb_build_object(
        'ok', true, 'message', 'POSTED', 'idempotent', true,
        'shipment_id', v_sid, 'ar_id', 'AR-' || v_sid
      );
    end if;
    raise exception 'ERR_SHIPMENT_EXISTS';
  end if;

  if v_parent_type not in ('SO', 'SHIPMENT') then raise exception 'ERR_PARENT_REF_TYPE'; end if;
  if v_parent_type = 'SO' then v_parent_id := v_so_id;
  elsif v_parent_id = '' then raise exception 'ERR_PARENT_REF_ID_REQUIRED'; end if;

  select * into v_so from sales_order where so_id = v_so_id for update;
  if not found then raise exception 'ERR_SO_NOT_FOUND: %', v_so_id; end if;
  if erp_norm_id(v_so.customer_id) <> v_cust then raise exception 'ERR_CUSTOMER_SO_MISMATCH'; end if;
  if upper(trim(coalesce(v_so.so_type, 'NORMAL'))) <> 'NORMAL' then
    raise exception 'ERR_SO_TYPE_NOT_NORMAL';
  end if;

  for v_i in 0 .. jsonb_array_length(p_items_json) - 1 loop
    v_item := p_items_json -> v_i;
    v_so_item_id := erp_norm_id(v_item ->> 'so_item_id');
    v_lot_id := erp_norm_id(v_item ->> 'lot_id');
    v_qty := round(coalesce((v_item ->> 'ship_qty')::numeric, 0), 6);
    if v_so_item_id = '' then raise exception 'ERR_SO_ITEM_REQUIRED items[%]', v_i; end if;
    if v_lot_id = '' then raise exception 'ERR_LOT_REQUIRED items[%]', v_i; end if;
    if v_qty <= 0 then raise exception 'ERR_SHIP_QTY_INVALID items[%]', v_i; end if;

    select * into v_so_item from sales_order_item
    where so_item_id = v_so_item_id and so_id = v_so_id for update;
    if not found then raise exception 'ERR_SO_ITEM_NOT_IN_SO: %', v_so_item_id; end if;

    select * into v_lot from lot where lot_id = v_lot_id;
    if not found then raise exception 'ERR_LOT_NOT_FOUND: %', v_lot_id; end if;
    if erp_norm_id(v_so_item.product_id) <> erp_norm_id(v_lot.product_id) then
      raise exception 'ERR_PRODUCT_LOT_MISMATCH';
    end if;

    v_delta := v_delta || jsonb_build_object(
      v_so_item_id, coalesce((v_delta ->> v_so_item_id)::numeric, 0) + v_qty
    );
    v_lot_demand := v_lot_demand || jsonb_build_object(
      v_lot_id, coalesce((v_lot_demand ->> v_lot_id)::numeric, 0) + v_qty
    );
  end loop;

  select array_agg(key order by key) into v_lot_keys from jsonb_each_text(v_lot_demand);
  if v_lot_keys is not null then
    foreach v_key in array v_lot_keys loop
      v_demand := (v_lot_demand ->> v_key)::numeric;
      select * into v_lot from lot where lot_id = v_key for update;
      v_avail := erp_lot_available_qty(v_key);
      if v_avail + 1e-9 < v_demand then
        raise exception 'Negative inventory is not allowed';
      end if;
    end loop;
  end if;

  for v_so_item_id, v_qty in select key, (value)::numeric from jsonb_each_text(v_delta) loop
    select * into v_so_item from sales_order_item
    where so_item_id = v_so_item_id and so_id = v_so_id for update;
    v_remain := round(coalesce(v_so_item.order_qty, 0) - coalesce(v_so_item.shipped_qty, 0), 6);
    if v_qty - v_remain > 1e-9 then
      raise exception 'Ship qty exceeds sales order remaining';
    end if;
  end loop;

  insert into shipment (
    shipment_id, so_id, customer_id, shipper_id, transaction_id,
    parent_ref_type, parent_ref_id, ship_date, status, remark,
    recipient_id, recipient_name, recipient_name_en, recipient_address, recipient_phone,
    consignment_case_id, created_by, created_at, updated_by, updated_at
  ) values (
    v_sid, v_so_id, v_cust, trim(p_shipper_id), v_tx,
    v_parent_type, v_parent_id, p_ship_date, 'POSTED', coalesce(p_remark, ''),
    erp_norm_id(p_recipient_id),
    trim(coalesce(p_recipient_name, '')),
    trim(coalesce(p_recipient_name_en, '')),
    trim(coalesce(p_recipient_address, '')),
    trim(coalesce(p_recipient_phone, '')),
    '',
    v_actor, p_ts, '', null
  );

  for v_i in 0 .. jsonb_array_length(p_items_json) - 1 loop
    v_item := p_items_json -> v_i;
    v_lot_id := erp_norm_id(v_item ->> 'lot_id');
    v_qty := round(coalesce((v_item ->> 'ship_qty')::numeric, 0), 6);
    v_so_item_id := erp_norm_id(v_item ->> 'so_item_id');
    v_shi_id := coalesce(
      nullif(trim(v_item ->> 'shipment_item_id'), ''),
      'SHI-' || v_sid || '-' || lpad((v_i + 1)::text, 3, '0')
    );

    select * into v_so_item from sales_order_item where so_item_id = v_so_item_id;
    select * into v_lot from lot where lot_id = v_lot_id;
    v_product_id := erp_norm_id(v_so_item.product_id);

    select elem into v_line
    from jsonb_array_elements(p_pricing_lines) elem
    where erp_norm_id(elem ->> 'shipment_item_id') = erp_norm_id(v_shi_id)
    limit 1;
    if v_line is null then
      raise exception 'ERR_PRICING_LINE_MISSING: %', v_shi_id;
    end if;

    insert into shipment_item (
      shipment_item_id, shipment_id, so_id, so_item_id, lot_id, product_id,
      transaction_id, parent_ref_type, parent_ref_id, ship_qty, unit, remark,
      so_pricing_snapshot_id, so_pricing_version,
      shipment_pricing_unit_price, shipment_pricing_billable_qty, shipment_pricing_free_qty,
      shipment_pricing_amount, applied_promo_scheme_id, applied_promo_type, applied_promo_scope,
      created_by, created_at, updated_by, updated_at
    ) values (
      v_shi_id, v_sid, v_so_id, v_so_item_id, v_lot_id, v_product_id,
      v_tx, 'SHIPMENT', v_sid, v_qty,
      trim(coalesce(v_item ->> 'unit', v_so_item.unit, v_lot.unit, '')),
      coalesce(v_item ->> 'remark', ''),
      nullif(trim(coalesce(v_line ->> 'so_pricing_snapshot_id', '')), ''),
      nullif((v_line ->> 'so_pricing_version')::text, '')::integer,
      round(coalesce((v_line ->> 'unit_price')::numeric, 0), 2),
      round(coalesce((v_line ->> 'billable_qty')::numeric, 0), 6),
      round(coalesce((v_line ->> 'free_qty')::numeric, 0), 6),
      round(coalesce((v_line ->> 'amount')::numeric, 0), 2),
      coalesce(v_line ->> 'promo_scheme_id', ''),
      coalesce(v_line ->> 'promo_type', ''),
      coalesce(nullif(trim(v_line ->> 'promo_scope'), ''), 'PER_SHIPMENT'),
      v_actor, p_ts, '', null
    );

    v_mv_id := erp_new_movement_id();
    insert into inventory_movement (
      movement_id, movement_type, lot_id, product_id, warehouse_id,
      transaction_id, parent_ref_type, parent_ref_id, qty, unit,
      ref_type, ref_id, issued_to, remark, created_by, created_at, system_remark
    ) values (
      v_mv_id, 'SHIP_OUT', v_lot_id, v_product_id,
      upper(trim(coalesce(v_lot.warehouse_id, 'MAIN'))),
      v_tx, 'SHIPMENT', v_sid, -abs(v_qty),
      trim(coalesce(v_so_item.unit, v_lot.unit, '')),
      'SHIPMENT', v_sid, '', coalesce(v_item ->> 'remark', ''),
      v_actor, p_ts, 'Ship OUT: ' || v_sid
    );

    update lot_balance
    set available_qty = coalesce(available_qty, 0) - v_qty,
        movement_count = coalesce(movement_count, 0) + 1,
        last_movement_id = v_mv_id,
        updated_at = p_ts, updated_by = v_actor
    where lot_id = v_lot_id;

    if not found then
      insert into lot_balance (lot_id, available_qty, movement_count, last_movement_id, updated_at, updated_by)
      values (
        v_lot_id,
        coalesce((select sum(m.qty) from inventory_movement m where m.lot_id = v_lot_id), 0),
        coalesce((select count(*)::int from inventory_movement m where m.lot_id = v_lot_id), 0),
        v_mv_id, p_ts, v_actor
      );
    end if;
  end loop;

  for v_so_item_id, v_qty in select key, (value)::numeric from jsonb_each_text(v_delta) loop
    select * into v_so_item from sales_order_item where so_item_id = v_so_item_id for update;
    v_next_shipped := coalesce(v_so_item.shipped_qty, 0) + v_qty;
    update sales_order_item
    set shipped_qty = v_next_shipped, updated_by = v_actor, updated_at = p_ts
    where so_item_id = v_so_item_id;
  end loop;

  update sales_order
  set status = erp_calc_so_status(v_so_id), updated_by = v_actor, updated_at = p_ts
  where so_id = v_so_id;

  v_ar_id := 'AR-' || v_sid;
  insert into ar_receivable (
    ar_id, source_type, source_id, customer_id, so_id, shipment_id,
    transaction_id, ar_date, currency,
    amount_system, amount_due, amount_received, status,
    remark, created_by, created_at, system_remark, dealer_cumulative_added
  ) values (
    v_ar_id, 'SHIPMENT', v_sid, v_cust, v_so_id, v_sid,
    v_tx, p_ship_date, v_currency,
    v_amount, v_amount, 0, 'OPEN',
    '', v_actor, p_ts, coalesce(p_system_remark, ''), 0
  );

  return jsonb_build_object(
    'ok', true, 'message', 'POSTED',
    'shipment_id', v_sid, 'so_id', v_so_id,
    'ar_id', v_ar_id, 'amount_system', v_amount
  );
end;
$$;

comment on function public.erp_ship_post_phase1_tx is
  'v4.3.2 Phase1：NORMAL 出貨 POST 單一 transaction；計價由 Node 傳入 p_pricing_lines';

revoke all on function public.erp_ship_post_phase1_tx(
  text, text, text, date, text, text, text, text, text, text, text, text, text, text,
  jsonb, jsonb, numeric, text, text, text, timestamptz
) from public;
grant execute on function public.erp_ship_post_phase1_tx(
  text, text, text, date, text, text, text, text, text, text, text, text, text, text,
  jsonb, jsonb, numeric, text, text, text, timestamptz
) to service_role;
