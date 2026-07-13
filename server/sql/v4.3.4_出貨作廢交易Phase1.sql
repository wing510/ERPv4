-- ERP v4.3.4：一般出貨作廢 Phase1 單一 DB transaction【僅 DEV】
-- 前置：v4.3.3_出貨過帳Dealer折抵原子.sql（含 erp_round_money / erp_calc_so_status / erp_new_movement_id）
-- 用途：NORMAL 出貨 VOID 原子化（還庫 / SO / 折抵還原 / AR 作廢 / shipment CANCELLED）
-- 寄賣 CONSIGNMENT：RPC 回 ERR_SO_TYPE_NOT_NORMAL，Node fallback

-- ── 折抵還原（對稱 v4.3.3 SHIPMENT_CREDIT）──────────────────────
create or replace function public.erp_restore_dealer_credit_on_ship_void_(
  p_customer_id text,
  p_shipment_id text,
  p_ar_id text,
  p_actor text,
  p_ts timestamptz default now()
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust text := erp_norm_id(p_customer_id);
  v_sid text := erp_norm_id(p_shipment_id);
  v_ar_id text := erp_norm_id(p_ar_id);
  v_actor text := trim(coalesce(p_actor, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_credit record;
  v_cut numeric := 0;
  v_reason text;
begin
  if v_cust = '' or v_sid = '' or v_ar_id = '' then return 0; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;

  if exists (
    select 1 from ar_amount_adjustment_log
    where source_type = 'SHIPMENT_CREDIT_VOID' and source_id = v_sid
  ) then
    return 0;
  end if;

  select * into v_credit
  from ar_amount_adjustment_log
  where source_type = 'SHIPMENT_CREDIT' and source_id = v_sid
  for update;

  if not found then return 0; end if;

  v_cut := erp_round_money(coalesce(v_credit.amount_before, 0) - coalesce(v_credit.amount_after, 0));
  if v_cut <= 0.000000001 then return 0; end if;

  v_reason := '作廢出貨還原經銷折抵（出貨 ' || v_sid || '）';

  begin
    insert into ar_amount_adjustment_log (
      adjust_id, ar_id, amount_before, amount_after, reason,
      adjusted_by, adjusted_at, source_type, source_id
    ) values (
      'ARA-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' ||
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)),
      v_ar_id,
      coalesce(v_credit.amount_after, 0),
      erp_round_money(coalesce(v_credit.amount_after, 0) + v_cut),
      v_reason, v_actor, v_ts, 'SHIPMENT_CREDIT_VOID', v_sid
    );
  exception when unique_violation then
    return 0;
  end;

  update customer
  set dealer_rebate_credit_balance = erp_round_money(coalesce(dealer_rebate_credit_balance, 0) + v_cut),
      updated_by = v_actor, updated_at = v_ts
  where customer_id = v_cust;

  if not found then raise exception 'ERR_CUSTOMER_NOT_FOUND: %', v_cust; end if;
  return v_cut;
end;
$$;

create or replace function public.erp_ar_sum_valid_payments_(p_ar_id text)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(
    case
      when coalesce(amount, 0) <= 0.0001 then 0
      when position('VOIDED|' in coalesce(system_remark, '')) > 0 then 0
      else amount
    end
  ), 0)::numeric
  from ar_payment
  where ar_id = erp_norm_id(p_ar_id);
$$;

create or replace function public.erp_assert_no_locked_dealer_rebate_for_ship_void_(
  p_customer_id text,
  p_ship_date date
)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cust text := erp_norm_id(p_customer_id);
  v_ym text := to_char(p_ship_date, 'YYYY-MM');
  v_reb record;
  v_stat record;
begin
  if v_cust = '' or p_ship_date is null then
    raise exception 'ERR_VOID_REBATE_GUARD_INCOMPLETE';
  end if;

  select rebate_id into v_reb
  from commercial_dealer_rebate
  where customer_id = v_cust and period_ym = v_ym
    and upper(trim(coalesce(status, ''))) <> 'VOID'
  limit 1;
  if found then
    raise exception 'ERR_LOCKED_DEALER_REBATE: period % rebate %', v_ym, v_reb.rebate_id;
  end if;

  select stat_id into v_stat
  from commercial_dealer_monthly_stat
  where customer_id = v_cust and period_ym = v_ym
    and upper(trim(coalesce(status, ''))) <> 'VOID'
  limit 1;
  if found then
    raise exception 'ERR_LOCKED_DEALER_STAT: period % stat %', v_ym, v_stat.stat_id;
  end if;
end;
$$;

create or replace function public.erp_assert_no_consignment_for_ship_cancel_(p_shipment_id text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sid text := erp_norm_id(p_shipment_id);
  v_pool record;
  v_stl_id text;
  v_ret_id text;
begin
  if v_sid = '' then return; end if;

  for v_pool in
    select pool_item_id, settled_qty, returned_qty
    from consignment_case_pool_item where shipment_id = v_sid
  loop
    if coalesce(v_pool.settled_qty, 0) > 1e-9 then
      raise exception 'ERR_CONSIGNMENT_CASE_SETTLED';
    end if;
    if coalesce(v_pool.returned_qty, 0) > 1e-9 then
      raise exception 'ERR_CONSIGNMENT_CASE_RETURNED';
    end if;

    select settlement_id into v_stl_id
    from consignment_case_settlement_item where pool_item_id = v_pool.pool_item_id limit 1;
    if found and exists (
      select 1 from consignment_case_settlement
      where settlement_id = v_stl_id and upper(trim(coalesce(status, ''))) = 'POSTED'
    ) then
      raise exception 'ERR_CONSIGNMENT_CASE_SETTLED';
    end if;

    select return_id into v_ret_id
    from consignment_case_return_item where pool_item_id = v_pool.pool_item_id limit 1;
    if found and exists (
      select 1 from consignment_case_return
      where return_id = v_ret_id and upper(trim(coalesce(status, ''))) = 'POSTED'
    ) then
      raise exception 'ERR_CONSIGNMENT_CASE_RETURNED';
    end if;
  end loop;
end;
$$;

-- ── NORMAL 出貨作廢（原子）──────────────────────────────────────
create or replace function public.erp_ship_void_phase1_tx(
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
  v_cust text;
  v_so_type text;
  v_ci record;
  v_ar_id text;
  v_ar record;
  v_received numeric;
  v_due numeric;
  v_item record;
  v_lot_id text;
  v_lot record;
  v_mv_id text;
  v_qty numeric;
  v_delta jsonb := '{}'::jsonb;
  v_so_item_id text;
  v_so_item record;
  v_next_shipped numeric;
  v_credit_restore numeric := 0;
begin
  if v_sid = '' then raise exception 'ERR_SHIPMENT_ID_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;

  select * into v_sh from shipment where shipment_id = v_sid for update;
  if not found then raise exception 'Shipment not found'; end if;

  if upper(trim(coalesce(v_sh.status, ''))) = 'CANCELLED' then
    return jsonb_build_object(
      'ok', true, 'message', 'CANCELLED', 'idempotent', true,
      'shipment_id', v_sid, 'ar_id', 'AR-' || v_sid, 'void_rpc', true
    );
  end if;
  if upper(trim(coalesce(v_sh.status, ''))) <> 'POSTED' then
    raise exception 'Only POSTED shipment can be cancelled';
  end if;

  v_so_id := erp_norm_id(v_sh.so_id);
  v_tx := trim(coalesce(v_sh.transaction_id, ''));
  v_cust := erp_norm_id(v_sh.customer_id);

  select upper(trim(coalesce(so_type, 'NORMAL'))) into v_so_type
  from sales_order where so_id = v_so_id;
  if v_so_type is null then raise exception 'ERR_SO_NOT_FOUND: %', v_so_id; end if;
  if v_so_type <> 'NORMAL' then
    raise exception 'ERR_SO_TYPE_NOT_NORMAL';
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

  select ci_id, ci_no, status into v_ci from commercial_invoice where shipment_id = v_sid;
  if found and upper(trim(coalesce(v_ci.status, ''))) <> 'VOID' then
    raise exception 'ERR_CI_NOT_VOID: Commercial Invoice must be voided first';
  end if;

  perform erp_assert_no_locked_dealer_rebate_for_ship_void_(v_cust, v_sh.ship_date);
  perform erp_assert_no_consignment_for_ship_cancel_(v_sid);

  v_ar_id := 'AR-' || v_sid;
  select * into v_ar from ar_receivable where ar_id = v_ar_id for update;
  if not found then raise exception 'ERR_AR_NOT_FOUND: %', v_ar_id; end if;

  if upper(trim(coalesce(v_ar.status, ''))) <> 'OPEN' then
    raise exception 'ERR_AR_EXISTS: Shipment has AR with payments or non-OPEN status. Resolve AR first.';
  end if;

  v_received := erp_round_money(erp_ar_sum_valid_payments_(v_ar_id));
  if v_received > 0.0001 then
    raise exception 'ERR_SHIPMENT_AR_HAS_PAYMENT: AR has payments, cannot void shipment AR';
  end if;

  for v_item in select * from shipment_item where shipment_id = v_sid loop
    v_qty := coalesce(v_item.ship_qty, 0);
    if v_qty <= 0 then continue; end if;
    v_lot_id := erp_norm_id(v_item.lot_id);
    if not exists (select 1 from lot where lot_id = v_lot_id) then
      raise exception 'Lot not found: %', v_lot_id;
    end if;
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

  v_credit_restore := erp_restore_dealer_credit_on_ship_void_(v_cust, v_sid, v_ar_id, v_actor, v_ts);

  select coalesce(amount_due, 0) into v_due from ar_receivable where ar_id = v_ar_id;
  v_due := erp_round_money(v_due);

  if v_due > 0.0001 then
    insert into ar_amount_adjustment_log (
      adjust_id, ar_id, amount_before, amount_after, reason, adjusted_by, adjusted_at
    ) values (
      'ARA-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' ||
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)),
      v_ar_id, v_due, 0, '作廢出貨：' || v_reason, v_actor, v_ts
    );
  end if;

  update ar_receivable
  set amount_due = 0,
      amount_received = v_received,
      status = 'SETTLED',
      close_mode = 'VOID',
      close_reason = v_reason,
      closed_by = v_actor,
      closed_at = v_ts,
      dealer_cumulative_added = 0,
      updated_by = v_actor,
      updated_at = v_ts,
      system_remark = left(
        trim(coalesce(system_remark, '')) ||
        case when coalesce(system_remark, '') <> '' then E'\n' else '' end ||
        '[' || to_char(v_ts, 'YYYY-MM-DD"T"HH24:MI:SS') || '] ' || v_actor ||
        ' 作廢出貨（應收 ' || v_due::text || ' → 0）：' || v_reason ||
        case when v_credit_restore > 0.0001 then ' | RESTORE dealer credit ' || v_credit_restore::text else '' end,
        4000
      )
  where ar_id = v_ar_id;

  update shipment
  set status = 'CANCELLED',
      remark = left(trim(coalesce(v_sh.remark, '')) || ' | CANCELLED', 4000),
      updated_by = v_actor,
      updated_at = v_ts
  where shipment_id = v_sid;

  return jsonb_build_object(
    'ok', true, 'message', 'CANCELLED',
    'shipment_id', v_sid,
    'ar_id', v_ar_id,
    'dealer_credit_restored', v_credit_restore,
    'void_rpc', true
  );
end;
$$;

comment on function public.erp_ship_void_phase1_tx is
  'v4.3.4 Phase1：NORMAL 出貨 VOID 單一 transaction；對齊 Node ADJUST+SHIPMENT_CANCEL';

revoke all on function public.erp_restore_dealer_credit_on_ship_void_(text, text, text, text, timestamptz) from public;
revoke all on function public.erp_ar_sum_valid_payments_(text) from public;
revoke all on function public.erp_assert_no_locked_dealer_rebate_for_ship_void_(text, date) from public;
revoke all on function public.erp_assert_no_consignment_for_ship_cancel_(text) from public;
revoke all on function public.erp_ship_void_phase1_tx(text, text, text, timestamptz) from public;

grant execute on function public.erp_restore_dealer_credit_on_ship_void_(text, text, text, text, timestamptz) to service_role;
grant execute on function public.erp_ar_sum_valid_payments_(text) to service_role;
grant execute on function public.erp_assert_no_locked_dealer_rebate_for_ship_void_(text, date) to service_role;
grant execute on function public.erp_assert_no_consignment_for_ship_cancel_(text) to service_role;
grant execute on function public.erp_ship_void_phase1_tx(text, text, text, timestamptz) to service_role;
