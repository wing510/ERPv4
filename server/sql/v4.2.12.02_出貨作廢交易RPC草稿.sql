-- ERP v4.2.12 遷移步驟 2【草稿 v2.4】：出貨作廢單一交易 RPC
-- ⚠ 草稿 v2.4：尚未在 Supabase 正式執行
-- v2.4：折抵還原寫 SHIPMENT_CREDIT_VOID 正式沖銷；mutation 全部驗證之後才寫

-- ── 出貨折抵正式沖銷（UNIQUE；勿只改 balance）─────────────────
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
  if v_cust = '' or v_sid = '' or v_ar_id = '' then
    return 0;
  end if;
  if v_actor = '' then
    raise exception 'ERR_ACTOR_REQUIRED';
  end if;

  -- 已沖銷 → 冪等
  if exists (
    select 1 from ar_amount_adjustment_log
    where source_type = 'SHIPMENT_CREDIT_VOID'
      and source_id = v_sid
  ) then
    return 0;
  end if;

  select * into v_credit
  from ar_amount_adjustment_log
  where source_type = 'SHIPMENT_CREDIT'
    and source_id = v_sid
  for update;

  if not found then
    return 0;
  end if;

  v_cut := erp_round_money(coalesce(v_credit.amount_before, 0) - coalesce(v_credit.amount_after, 0));
  if v_cut <= 0.000000001 then
    return 0;
  end if;

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
      v_reason,
      v_actor,
      v_ts,
      'SHIPMENT_CREDIT_VOID',
      v_sid
    );
  exception when unique_violation then
    return 0;
  end;

  update customer
  set dealer_rebate_credit_balance = erp_round_money(coalesce(dealer_rebate_credit_balance, 0) + v_cut),
      updated_by = v_actor,
      updated_at = v_ts
  where customer_id = v_cust;

  if not found then
    raise exception 'ERR_CUSTOMER_NOT_FOUND: %', v_cust;
  end if;

  return v_cut;
end;
$$;

revoke all on function public.erp_restore_dealer_credit_on_ship_void_(text, text, text, text, timestamptz) from public;
grant execute on function public.erp_restore_dealer_credit_on_ship_void_(text, text, text, text, timestamptz) to service_role;

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
      when coalesce(amount, 0) <= 0.0001 and left(coalesce(remark, ''), 4) = '[已作廢]' then 0
      else amount
    end
  ), 0)::numeric
  from ar_payment
  where ar_id = erp_norm_id(p_ar_id);
$$;

-- ── 作廢出貨前：月結回饋／月結統計護欄 ─────────────────────────
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
  where customer_id = v_cust
    and period_ym = v_ym
    and upper(trim(coalesce(status, ''))) <> 'VOID'
  limit 1;

  if found then
    raise exception 'ERR_LOCKED_DEALER_REBATE: period % rebate %', v_ym, v_reb.rebate_id;
  end if;

  select stat_id into v_stat
  from commercial_dealer_monthly_stat
  where customer_id = v_cust
    and period_ym = v_ym
    and upper(trim(coalesce(status, ''))) <> 'VOID'
  limit 1;

  if found then
    raise exception 'ERR_LOCKED_DEALER_STAT: period % stat %', v_ym, v_stat.stat_id;
  end if;
end;
$$;

-- ── 作廢出貨前：寄賣 pool／結算／收回護欄 ───────────────────────
create or replace function public.erp_assert_no_consignment_for_ship_cancel_(
  p_shipment_id text
)
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
    from consignment_case_pool_item
    where shipment_id = v_sid
  loop
    if coalesce(v_pool.settled_qty, 0) > 1e-9 then
      raise exception 'ERR_CONSIGNMENT_CASE_SETTLED';
    end if;
    if coalesce(v_pool.returned_qty, 0) > 1e-9 then
      raise exception 'ERR_CONSIGNMENT_CASE_RETURNED';
    end if;

    select settlement_id into v_stl_id
    from consignment_case_settlement_item
    where pool_item_id = v_pool.pool_item_id
    limit 1;
    if found then
      if exists (
        select 1 from consignment_case_settlement
        where settlement_id = v_stl_id
          and upper(trim(coalesce(status, ''))) = 'POSTED'
      ) then
        raise exception 'ERR_CONSIGNMENT_CASE_SETTLED';
      end if;
    end if;

    select return_id into v_ret_id
    from consignment_case_return_item
    where pool_item_id = v_pool.pool_item_id
    limit 1;
    if found then
      if exists (
        select 1 from consignment_case_return
        where return_id = v_ret_id
          and upper(trim(coalesce(status, ''))) = 'POSTED'
      ) then
        raise exception 'ERR_CONSIGNMENT_CASE_RETURNED';
      end if;
    end if;
  end loop;
end;
$$;

create or replace function public.erp_ship_void_tx(
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
  v_sh record;
  v_so_id text;
  v_tx text;
  v_cust text;
  v_so_type text;
  v_so record;
  v_ci record;
  v_ar_id text;
  v_ar record;
  v_received numeric;
  v_item_cnt int;
  v_ship_out_cnt int;
  v_item record;
  v_lot_id text;
  v_lot record;
  v_mv_id text;
  v_qty numeric;
  v_delta jsonb := '{}'::jsonb;
  v_so_item_id text;
  v_so_item record;
  v_next_shipped numeric;
  v_cum_rev numeric := 0;
  v_credit_restore numeric := 0;
begin
  if v_sid = '' then raise exception 'ERR_SHIPMENT_ID_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;

  select * into v_sh from shipment where shipment_id = v_sid for update;
  if not found then raise exception 'ERR_SHIPMENT_NOT_FOUND: %', v_sid; end if;

  if upper(trim(coalesce(v_sh.status, ''))) = 'CANCELLED' then
    return jsonb_build_object(
      'ok', true, 'message', 'CANCELLED', 'idempotent', true,
      'shipment_id', v_sid,
      'ar_id', 'AR-' || v_sid
    );
  end if;
  if upper(trim(coalesce(v_sh.status, ''))) <> 'POSTED' then
    raise exception 'ERR_ONLY_POSTED_CAN_CANCEL';
  end if;

  v_so_id := erp_norm_id(v_sh.so_id);
  v_tx := trim(coalesce(v_sh.transaction_id, ''));
  v_cust := erp_norm_id(v_sh.customer_id);

  select count(*)::int into v_item_cnt from shipment_item where shipment_id = v_sid;
  if coalesce(v_item_cnt, 0) < 1 then
    raise exception 'ERR_SHIPMENT_ITEMS_EMPTY';
  end if;

  select count(*)::int into v_ship_out_cnt
  from inventory_movement
  where upper(trim(ref_type)) = 'SHIPMENT'
    and upper(trim(ref_id)) = v_sid
    and upper(trim(movement_type)) = 'SHIP_OUT';

  if coalesce(v_ship_out_cnt, 0) < 1 then
    raise exception 'ERR_SHIP_OUT_MOVEMENT_MISSING';
  end if;

  select ci_id, ci_no, status into v_ci from commercial_invoice where shipment_id = v_sid;
  if found and upper(trim(coalesce(v_ci.status, ''))) <> 'VOID' then
    raise exception 'ERR_CI_NOT_VOID: %', coalesce(v_ci.ci_no, v_ci.ci_id);
  end if;

  select * into v_so from sales_order where so_id = v_so_id for update;
  if not found then raise exception 'ERR_SO_NOT_FOUND: %', v_so_id; end if;

  v_so_type := upper(trim(coalesce(v_so.so_type, 'NORMAL')));

  if v_so_type = 'NORMAL' then
    perform erp_assert_no_locked_dealer_rebate_for_ship_void_(v_cust, v_sh.ship_date);
  end if;
  perform erp_assert_no_consignment_for_ship_cancel_(v_sid);

  v_ar_id := 'AR-' || v_sid;

  if v_so_type = 'NORMAL' then
    select * into v_ar from ar_receivable where ar_id = v_ar_id for update;
    if not found then
      raise exception 'ERR_AR_NOT_FOUND: %', v_ar_id;
    end if;

    v_received := erp_round_money(erp_ar_sum_valid_payments_(v_ar_id));
    if v_received > 0.0001 then
      raise exception 'ERR_AR_HAS_PAYMENT';
    end if;

    perform erp_dealer_ledger_assert_void_general_ready_(v_cust, v_sid);

    -- ① 只讀：預算折抵還原額／確認尚未寫 VOID 沖銷（不改 balance）
    select coalesce(sum(amount_before - amount_after), 0) into v_credit_restore
    from ar_amount_adjustment_log
    where source_type = 'SHIPMENT_CREDIT'
      and source_id = v_sid;
    v_credit_restore := erp_round_money(v_credit_restore);
    if v_credit_restore > 0.0001 and exists (
      select 1 from ar_amount_adjustment_log
      where source_type = 'SHIPMENT_CREDIT_VOID'
        and source_id = v_sid
    ) then
      -- 已沖銷過：本輪不再還原（冪等）
      v_credit_restore := 0;
    end if;

  elsif v_so_type = 'CONSIGNMENT' then
    raise exception 'ERR_NOT_IMPLEMENTED: consignment pool remove in ship_void_tx v2.4';
  end if;

  -- ② 還庫前：驗證 lot／SO 明細存在（不寫入）
  for v_item in select * from shipment_item where shipment_id = v_sid loop
    v_qty := coalesce(v_item.ship_qty, 0);
    if v_qty <= 0 then continue; end if;

    v_lot_id := erp_norm_id(v_item.lot_id);
    if not exists (select 1 from lot where lot_id = v_lot_id) then
      raise exception 'ERR_LOT_NOT_FOUND: %', v_lot_id;
    end if;

    v_so_item_id := erp_norm_id(v_item.so_item_id);
    if v_so_item_id <> '' then
      if not exists (
        select 1 from sales_order_item
        where so_item_id = v_so_item_id and so_id = v_so_id
      ) then
        raise exception 'ERR_SO_ITEM_NOT_FOUND_ON_VOID: %', v_so_item_id;
      end if;
      v_delta := v_delta || jsonb_build_object(
        v_so_item_id, coalesce((v_delta ->> v_so_item_id)::numeric, 0) + v_qty
      );
    end if;
  end loop;

  -- ③ 還庫 + 還原 SO shipped_qty
  for v_item in select * from shipment_item where shipment_id = v_sid loop
    v_qty := coalesce(v_item.ship_qty, 0);
    if v_qty <= 0 then continue; end if;

    v_lot_id := erp_norm_id(v_item.lot_id);
    select * into v_lot from lot where lot_id = v_lot_id for update;
    if not found then raise exception 'ERR_LOT_NOT_FOUND: %', v_lot_id; end if;

    v_mv_id := erp_new_movement_id();
    insert into inventory_movement (
      movement_id, movement_type, lot_id, product_id, warehouse_id,
      transaction_id, parent_ref_type, parent_ref_id, qty, unit,
      ref_type, ref_id, issued_to, remark, created_by, created_at, system_remark
    ) values (
      v_mv_id, 'SHIP_VOID', v_lot_id, erp_norm_id(coalesce(v_item.product_id, v_lot.product_id)),
      upper(trim(coalesce(v_lot.warehouse_id, 'MAIN'))),
      v_tx, 'SHIPMENT', v_sid, abs(v_qty),
      trim(coalesce(v_item.unit, v_lot.unit, '')),
      'SHIPMENT_CANCEL', v_sid, '', v_reason,
      v_actor, p_ts, 'Cancel Shipment: ' || v_sid
    );

    update lot_balance
    set available_qty = coalesce(available_qty, 0) + v_qty,
        movement_count = coalesce(movement_count, 0) + 1,
        last_movement_id = v_mv_id,
        updated_at = p_ts, updated_by = v_actor
    where lot_id = v_lot_id;

    if not found then
      insert into lot_balance (lot_id, available_qty, movement_count, last_movement_id, updated_at, updated_by)
      select v_lot_id,
        coalesce((select sum(m.qty) from inventory_movement m where m.lot_id = v_lot_id), 0),
        coalesce((select count(*) from inventory_movement m where m.lot_id = v_lot_id), 0),
        v_mv_id, p_ts, v_actor;
    end if;
  end loop;

  for v_so_item_id, v_qty in select key, (value)::numeric from jsonb_each_text(v_delta) loop
    select * into v_so_item from sales_order_item
    where so_item_id = v_so_item_id and so_id = v_so_id for update;
    if not found then
      raise exception 'ERR_SO_ITEM_NOT_FOUND_ON_VOID: %', v_so_item_id;
    end if;
    v_next_shipped := greatest(0, coalesce(v_so_item.shipped_qty, 0) - v_qty);
    update sales_order_item
    set shipped_qty = v_next_shipped, updated_by = v_actor, updated_at = p_ts
    where so_item_id = v_so_item_id;
  end loop;

  update sales_order
  set status = erp_calc_so_status(v_so_id), updated_by = v_actor, updated_at = p_ts
  where so_id = v_so_id;

  if v_so_type = 'NORMAL' then
    -- ④ mutation：ledger VOID → 折抵正式沖銷 → 關 AR
    v_cum_rev := erp_dealer_ledger_void_general_shipment(v_cust, v_sid, v_actor, p_ts);
    v_credit_restore := erp_restore_dealer_credit_on_ship_void_(
      v_cust, v_sid, v_ar_id, v_actor, p_ts
    );

    update ar_receivable
    set status = 'SETTLED',
        close_mode = 'VOID',
        close_reason = v_reason,
        closed_by = v_actor,
        closed_at = p_ts,
        amount_due = coalesce(amount_received, 0),
        dealer_cumulative_added = 0,
        updated_by = v_actor,
        updated_at = p_ts,
        system_remark = left(
          trim(coalesce(system_remark, '')) ||
          case when v_credit_restore > 0.0001 then ' | RESTORE dealer credit ' || v_credit_restore::text else '' end ||
          ' | VOID shipment ' || v_sid,
          4000
        )
    where ar_id = v_ar_id;
  end if;

  update shipment
  set status = 'CANCELLED',
      remark = left(trim(coalesce(v_sh.remark, '')) || ' | CANCELLED', 4000),
      updated_by = v_actor,
      updated_at = p_ts
  where shipment_id = v_sid;

  return jsonb_build_object(
    'ok', true, 'message', 'CANCELLED',
    'shipment_id', v_sid,
    'ar_id', v_ar_id,
    'cumulative_reversed', v_cum_rev,
    'dealer_credit_restored', v_credit_restore
  );
end;
$$;

comment on function public.erp_ship_void_tx is
  'v4.2.12 草稿 v2.4：先驗證後 mutation；折抵沖銷＝SHIPMENT_CREDIT_VOID';

revoke all on function public.erp_ar_sum_valid_payments_(text) from public;
revoke all on function public.erp_assert_no_locked_dealer_rebate_for_ship_void_(text, date) from public;
revoke all on function public.erp_assert_no_consignment_for_ship_cancel_(text) from public;
revoke all on function public.erp_restore_dealer_credit_on_ship_void_(text, text, text, text, timestamptz) from public;
revoke all on function public.erp_ship_void_tx(text, text, text, timestamptz) from public;

grant execute on function public.erp_ar_sum_valid_payments_(text) to service_role;
grant execute on function public.erp_assert_no_locked_dealer_rebate_for_ship_void_(text, date) to service_role;
grant execute on function public.erp_assert_no_consignment_for_ship_cancel_(text) to service_role;
grant execute on function public.erp_restore_dealer_credit_on_ship_void_(text, text, text, text, timestamptz) to service_role;
grant execute on function public.erp_ship_void_tx(text, text, text, timestamptz) to service_role;
