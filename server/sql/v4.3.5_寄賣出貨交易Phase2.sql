-- ERP v4.3.5：寄賣出貨 POST/VOID Phase2 單一 DB transaction【僅 DEV】
-- 前置：v4.2.2.00_寄賣案件建表.sql、v4.3.2 工具函式（erp_norm_id / erp_new_movement_id / erp_calc_so_status 等）
-- 用途：CONSIGNMENT 寄賣出貨過帳／作廢原子化（shipment / 庫存 / SO / 案件品項池）
-- 不含：結算、收回、AR（Phase 2 後續）

-- ── 寄賣出貨 POST（原子）────────────────────────────────────────
create or replace function public.erp_ship_post_consignment_phase2_tx(
  p_shipment_id text,
  p_so_id text,
  p_customer_id text,
  p_consignment_case_id text,
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
  v_case_id text := erp_norm_id(p_consignment_case_id);
  v_actor text := trim(coalesce(p_actor, ''));
  v_tx text := trim(coalesce(p_transaction_id, ''));
  v_parent_type text := upper(trim(coalesce(p_parent_ref_type, 'SO')));
  v_parent_id text := erp_norm_id(p_parent_ref_id);
  v_existed record;
  v_so record;
  v_case record;
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
  v_pool_id text;
  v_factory_lot text;
  v_wh text;
  v_pool_count int := 0;
begin
  if v_sid = '' then raise exception 'ERR_SHIPMENT_ID_REQUIRED'; end if;
  if v_so_id = '' then raise exception 'ERR_SO_ID_REQUIRED'; end if;
  if v_cust = '' then raise exception 'ERR_CUSTOMER_ID_REQUIRED'; end if;
  if v_case_id = '' then raise exception 'consignment_case_id required for CONSIGNMENT shipment'; end if;
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

  select * into v_existed from shipment where shipment_id = v_sid;
  if found then
    if upper(trim(coalesce(v_existed.status, ''))) = 'POSTED'
       and trim(coalesce(v_existed.transaction_id, '')) = v_tx then
      return jsonb_build_object(
        'ok', true, 'message', 'POSTED', 'idempotent', true,
        'shipment_id', v_sid, 'consignment_case_id', v_case_id,
        'consignment_rpc', true
      );
    end if;
    raise exception 'ERR_SHIPMENT_EXISTS';
  end if;

  select * into v_case from consignment_case where case_id = v_case_id for update;
  if not found then raise exception 'Consignment case not found: %', v_case_id; end if;
  if upper(trim(coalesce(v_case.status, ''))) = 'CLOSED' then
    raise exception 'Consignment case is CLOSED';
  end if;
  if erp_norm_id(v_case.customer_id) <> v_cust then
    raise exception 'Shipment customer does not match consignment case customer';
  end if;

  if v_parent_type not in ('SO', 'SHIPMENT') then raise exception 'ERR_PARENT_REF_TYPE'; end if;
  if v_parent_type = 'SO' then v_parent_id := v_so_id;
  elsif v_parent_id = '' then raise exception 'ERR_PARENT_REF_ID_REQUIRED'; end if;

  select * into v_so from sales_order where so_id = v_so_id for update;
  if not found then raise exception 'ERR_SO_NOT_FOUND: %', v_so_id; end if;
  if erp_norm_id(v_so.customer_id) <> v_cust then raise exception 'ERR_CUSTOMER_SO_MISMATCH'; end if;
  if upper(trim(coalesce(v_so.so_type, 'NORMAL'))) <> 'CONSIGNMENT' then
    raise exception 'ERR_SO_TYPE_NOT_CONSIGNMENT';
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
    v_case_id,
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
    v_factory_lot := upper(trim(coalesce(v_lot.factory_lot, '')));
    v_wh := upper(trim(coalesce(v_lot.warehouse_id, 'MAIN')));
    if v_wh = '' then v_wh := 'MAIN'; end if;

    insert into shipment_item (
      shipment_item_id, shipment_id, so_id, so_item_id, lot_id, product_id,
      transaction_id, parent_ref_type, parent_ref_id, ship_qty, unit, remark,
      created_by, created_at, updated_by, updated_at
    ) values (
      v_shi_id, v_sid, v_so_id, v_so_item_id, v_lot_id, v_product_id,
      v_tx, 'SHIPMENT', v_sid, v_qty,
      trim(coalesce(v_item ->> 'unit', v_so_item.unit, v_lot.unit, '')),
      coalesce(v_item ->> 'remark', ''),
      v_actor, p_ts, '', null
    );

    v_mv_id := erp_new_movement_id();
    insert into inventory_movement (
      movement_id, movement_type, lot_id, product_id, warehouse_id,
      transaction_id, parent_ref_type, parent_ref_id, qty, unit,
      ref_type, ref_id, issued_to, remark, created_by, created_at, system_remark
    ) values (
      v_mv_id, 'SHIP_OUT', v_lot_id, v_product_id, v_wh,
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

    v_pool_id := v_case_id || '-PL-' || v_sid || '-' || lpad((v_i + 1)::text, 3, '0');
    insert into consignment_case_pool_item (
      pool_item_id, case_id, shipment_id, shipment_item_id,
      so_id, so_item_id, product_id, lot_id, factory_lot, warehouse_id,
      ship_qty, settled_qty, returned_qty, unit, unit_price,
      ship_date, transaction_id, remark,
      created_by, created_at, updated_by, updated_at
    ) values (
      v_pool_id, v_case_id, v_sid, v_shi_id,
      v_so_id, v_so_item_id, v_product_id, v_lot_id, v_factory_lot, v_wh,
      v_qty, 0, 0,
      trim(coalesce(v_item ->> 'unit', v_so_item.unit, v_lot.unit, '')),
      round(coalesce(v_so_item.unit_price, 0)::numeric, 2),
      p_ship_date, v_tx, '',
      v_actor, p_ts, '', null
    );
    v_pool_count := v_pool_count + 1;
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

  return jsonb_build_object(
    'ok', true, 'message', 'POSTED',
    'shipment_id', v_sid, 'so_id', v_so_id,
    'consignment_case_id', v_case_id,
    'pool_item_count', v_pool_count,
    'consignment_rpc', true
  );
end;
$$;

-- ── 寄賣出貨 VOID（原子）────────────────────────────────────────
create or replace function public.erp_ship_void_consignment_phase2_tx(
  p_shipment_id text,
  p_void_reason text default '作廢出貨',
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
  v_actor text := trim(coalesce(p_actor, ''));
  v_reason text := trim(coalesce(p_void_reason, '作廢出貨'));
  v_ts timestamptz := coalesce(p_ts, now());
  v_sh record;
  v_so_id text;
  v_tx text;
  v_so_type text;
  v_item record;
  v_lot_id text;
  v_lot record;
  v_mv_id text;
  v_qty numeric;
  v_delta jsonb := '{}'::jsonb;
  v_so_item_id text;
  v_so_item record;
  v_next_shipped numeric;
  v_pool_removed int := 0;
  v_case_id text;
begin
  if v_sid = '' then raise exception 'ERR_SHIPMENT_ID_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;

  select * into v_sh from shipment where shipment_id = v_sid for update;
  if not found then raise exception 'Shipment not found'; end if;

  if upper(trim(coalesce(v_sh.status, ''))) = 'CANCELLED' then
    return jsonb_build_object(
      'ok', true, 'message', 'CANCELLED', 'idempotent', true,
      'shipment_id', v_sid, 'consignment_rpc', true
    );
  end if;
  if upper(trim(coalesce(v_sh.status, ''))) <> 'POSTED' then
    raise exception 'Only POSTED shipment can be cancelled';
  end if;

  v_so_id := erp_norm_id(v_sh.so_id);
  v_tx := trim(coalesce(v_sh.transaction_id, ''));
  v_case_id := erp_norm_id(v_sh.consignment_case_id);

  select upper(trim(coalesce(so_type, 'NORMAL'))) into v_so_type
  from sales_order where so_id = v_so_id;
  if v_so_type <> 'CONSIGNMENT' then
    raise exception 'ERR_SO_TYPE_NOT_CONSIGNMENT';
  end if;

  if not exists (select 1 from shipment_item where shipment_id = v_sid) then
    raise exception 'Shipment items not found';
  end if;

  if exists (
    select 1 from inventory_movement
    where upper(trim(ref_type)) = 'SHIPMENT_CANCEL' and upper(trim(ref_id)) = v_sid
  ) then
    raise exception 'Shipment cancel movement already exists';
  end if;

  if exists (
    select 1 from commercial_invoice where shipment_id = v_sid
      and upper(trim(coalesce(status, ''))) <> 'VOID'
  ) then
    raise exception 'ERR_CI_NOT_VOID: Commercial Invoice must be voided first';
  end if;

  perform erp_assert_no_consignment_for_ship_cancel_(v_sid);

  for v_item in select * from shipment_item where shipment_id = v_sid loop
    v_qty := coalesce(v_item.ship_qty, 0);
    if v_qty <= 0 then continue; end if;
    v_so_item_id := erp_norm_id(v_item.so_item_id);
    if v_so_item_id <> '' then
      v_delta := v_delta || jsonb_build_object(
        v_so_item_id, coalesce((v_delta ->> v_so_item_id)::numeric, 0) + v_qty
      );
    end if;
  end loop;

  for v_item in select * from shipment_item where shipment_id = v_sid loop
    v_qty := coalesce(v_item.ship_qty, 0);
    if v_qty <= 0 then continue; end if;

    v_lot_id := erp_norm_id(v_item.lot_id);
    select * into v_lot from lot where lot_id = v_lot_id for update;
    if not found then raise exception 'Lot not found: %', v_lot_id; end if;

    v_mv_id := erp_new_movement_id();
    insert into inventory_movement (
      movement_id, movement_type, lot_id, product_id, warehouse_id,
      transaction_id, parent_ref_type, parent_ref_id, qty, unit,
      ref_type, ref_id, issued_to, remark, created_by, created_at, system_remark
    ) values (
      v_mv_id, 'ADJUST', v_lot_id, erp_norm_id(coalesce(v_item.product_id, v_lot.product_id)),
      upper(trim(coalesce(v_lot.warehouse_id, 'MAIN'))),
      v_tx, 'SHIPMENT', v_sid, abs(v_qty),
      trim(coalesce(v_item.unit, v_lot.unit, '')),
      'SHIPMENT_CANCEL', v_sid, '', v_reason,
      v_actor, v_ts, 'Cancel Shipment: ' || v_sid
    );

    update lot_balance
    set available_qty = coalesce(available_qty, 0) + v_qty,
        movement_count = coalesce(movement_count, 0) + 1,
        last_movement_id = v_mv_id,
        updated_at = v_ts, updated_by = v_actor
    where lot_id = v_lot_id;

    if not found then
      insert into lot_balance (lot_id, available_qty, movement_count, last_movement_id, updated_at, updated_by)
      select v_lot_id,
        coalesce((select sum(m.qty) from inventory_movement m where m.lot_id = v_lot_id), 0),
        coalesce((select count(*)::int from inventory_movement m where m.lot_id = v_lot_id), 0),
        v_mv_id, v_ts, v_actor;
    end if;
  end loop;

  for v_so_item_id, v_qty in select key, (value)::numeric from jsonb_each_text(v_delta) loop
    select * into v_so_item from sales_order_item
    where so_item_id = v_so_item_id and so_id = v_so_id for update;
    if not found then raise exception 'Sales order item not found: %', v_so_item_id; end if;
    v_next_shipped := greatest(0, coalesce(v_so_item.shipped_qty, 0) - v_qty);
    update sales_order_item
    set shipped_qty = v_next_shipped, updated_by = v_actor, updated_at = v_ts
    where so_item_id = v_so_item_id;
  end loop;

  update sales_order
  set status = erp_calc_so_status(v_so_id), updated_by = v_actor, updated_at = v_ts
  where so_id = v_so_id;

  delete from consignment_case_pool_item where shipment_id = v_sid;
  get diagnostics v_pool_removed = row_count;

  update shipment
  set status = 'CANCELLED',
      remark = left(trim(coalesce(v_sh.remark, '')) || ' | CANCELLED', 4000),
      updated_by = v_actor,
      updated_at = v_ts
  where shipment_id = v_sid;

  return jsonb_build_object(
    'ok', true, 'message', 'CANCELLED',
    'shipment_id', v_sid,
    'consignment_case_id', v_case_id,
    'pool_items_removed', v_pool_removed,
    'consignment_rpc', true
  );
end;
$$;

comment on function public.erp_ship_post_consignment_phase2_tx is
  'v4.3.5 Phase2：CONSIGNMENT 出貨 POST 單一 transaction（含案件品項池）';
comment on function public.erp_ship_void_consignment_phase2_tx is
  'v4.3.5 Phase2：CONSIGNMENT 出貨 VOID 單一 transaction（含移除品項池）';

revoke all on function public.erp_ship_post_consignment_phase2_tx(
  text, text, text, text, date, text, text, text, text, text, text, text, text, text, text,
  jsonb, text, timestamptz
) from public;
revoke all on function public.erp_ship_void_consignment_phase2_tx(text, text, text, timestamptz) from public;

grant execute on function public.erp_ship_post_consignment_phase2_tx(
  text, text, text, text, date, text, text, text, text, text, text, text, text, text, text,
  jsonb, text, timestamptz
) to service_role;
grant execute on function public.erp_ship_void_consignment_phase2_tx(text, text, text, timestamptz) to service_role;
