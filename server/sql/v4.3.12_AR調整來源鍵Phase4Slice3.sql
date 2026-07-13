-- ERP v4.3.12：AR Phase4 slice3 — 調整 log 全面 source_type/source_id【僅 DEV】
-- 前置：v4.3.3（欄位與 unique index）、v4.3.10、v4.3.11
-- 用途：補 backfill 既有調整列；修正 v4.3.4 出貨作廢 AR 歸零調整冪等鍵

comment on column ar_amount_adjustment_log.source_type is
  '調整來源類型：SHIPMENT_CREDIT/SHIPMENT_CREDIT_VOID/SHIPMENT_VOID/SETTLEMENT_CREDIT/MONTHLY_REBATE_CN/MONTHLY_REBATE_CN_VOID/PAYMENT_GAP_WRITEOFF/PAYMENT_GAP_WRITEOFF_VOID/AR_FORCE_CLOSE/CONSIGNMENT_SETTLEMENT_VOID/MANUAL_ADJUST/AR_SYSTEM_REPAIR';
comment on column ar_amount_adjustment_log.source_id is
  '調整來源鍵；與 source_type 組成財務冪等鍵（partial unique index）';

-- ── Backfill：出貨經銷折抵 ────────────────────────────────────────
update ar_amount_adjustment_log
set source_type = 'SHIPMENT_CREDIT',
    source_id = upper(trim((regexp_match(reason, '出貨 ([A-Z0-9-]+)'))[1]))
where coalesce(source_type, '') = ''
  and reason ~ '^經銷回饋折抵（出貨 [A-Z0-9-]+）';

-- ── Backfill：結算經銷折抵 ────────────────────────────────────────
update ar_amount_adjustment_log
set source_type = 'SETTLEMENT_CREDIT',
    source_id = upper(trim((regexp_match(reason, '結算 ([A-Z0-9-]+)'))[1]))
where coalesce(source_type, '') = ''
  and reason ~ '^經銷回饋折抵（結算 [A-Z0-9-]+）';

-- ── Backfill：作廢出貨 AR 歸零 ───────────────────────────────────
update ar_amount_adjustment_log a
set source_type = 'SHIPMENT_VOID',
    source_id = upper(trim(replace(a.ar_id, 'AR-', '')))
where coalesce(a.source_type, '') = ''
  and a.reason ~ '^作廢出貨：'
  and a.ar_id like 'AR-SH-%';

-- ── Backfill：作廢寄賣結算 ───────────────────────────────────────
update ar_amount_adjustment_log a
set source_type = 'CONSIGNMENT_SETTLEMENT_VOID',
    source_id = coalesce(
      nullif(upper(trim(r.settlement_id)), ''),
      nullif(upper(trim(r.source_id)), ''),
      a.ar_id
    )
from ar_receivable r
where r.ar_id = a.ar_id
  and coalesce(a.source_type, '') = ''
  and a.reason ~ '^作廢寄賣結算：';

-- ── Backfill：強制結案沖銷 ───────────────────────────────────────
update ar_amount_adjustment_log
set source_type = 'AR_FORCE_CLOSE',
    source_id = ar_id
where coalesce(source_type, '') = ''
  and reason ~ '^強制結案沖銷：';

-- ── Backfill：登記收款沖銷差額（從 payment system_remark 連結）────
update ar_amount_adjustment_log a
set source_type = 'PAYMENT_GAP_WRITEOFF',
    source_id = p.payment_id
from ar_payment p
where coalesce(a.source_type, '') = ''
  and a.reason ~ '^登記收款沖銷差額：'
  and position('gap_writeoff|adjust_id=' || a.adjust_id in coalesce(p.system_remark, '')) > 0;

-- ── Backfill：作廢收款還原沖銷差額（以 payment 推斷）──────────────
update ar_amount_adjustment_log a
set source_type = 'PAYMENT_GAP_WRITEOFF_VOID',
    source_id = p.payment_id
from ar_payment p
where coalesce(a.source_type, '') = ''
  and a.reason ~ '^作廢收款還原沖銷差額'
  and exists (
    select 1 from ar_amount_adjustment_log g
    where g.source_type = 'PAYMENT_GAP_WRITEOFF'
      and g.source_id = p.payment_id
      and g.ar_id = a.ar_id
  );

-- ── Backfill：月結回饋折讓（reason 保留；source_id 用 ar_id 過渡）──
update ar_amount_adjustment_log
set source_type = 'MONTHLY_REBATE_CN',
    source_id = ar_id
where coalesce(source_type, '') = ''
  and reason ~ '^經銷月結回饋折讓（';

update ar_amount_adjustment_log
set source_type = 'MONTHLY_REBATE_CN_VOID',
    source_id = ar_id
where coalesce(source_type, '') = ''
  and reason ~ '^作廢經銷月結回饋（';

-- ── Backfill：其餘手動調整 ───────────────────────────────────────
update ar_amount_adjustment_log
set source_type = 'MANUAL_ADJUST',
    source_id = adjust_id
where coalesce(source_type, '') = '';

-- ── 修正 v4.3.4 出貨作廢：AR 歸零調整寫入冪等鍵 ─────────────────
drop function if exists public.erp_ship_void_phase1_tx(text, text, text, timestamptz);

create or replace function public.erp_ship_void_phase1_tx(
  p_shipment_id text,
  p_void_reason text,
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
  v_reason text := trim(coalesce(p_void_reason, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_sh shipment%rowtype;
  v_so_id text;
  v_cust text;
  v_ar_id text;
  v_ar ar_receivable%rowtype;
  v_received numeric;
  v_due numeric;
  v_ci record;
  v_item record;
  v_lot record;
  v_lot_id text;
  v_so_item_id text;
  v_qty numeric;
  v_mv_id text;
  v_tx text;
  v_delta jsonb := '{}'::jsonb;
  v_so_item record;
  v_next_shipped numeric;
  v_credit_restore numeric := 0;
begin
  if v_sid = '' then raise exception 'shipment_id required'; end if;
  if v_actor = '' then raise exception 'actor required'; end if;

  select * into v_sh from shipment where shipment_id = v_sid for update;
  if not found then raise exception 'Shipment not found: %', v_sid; end if;
  if upper(trim(coalesce(v_sh.status, ''))) = 'CANCELLED' then
    return jsonb_build_object('ok', true, 'message', 'CANCELLED', 'shipment_id', v_sid, 'idempotent', true, 'void_rpc', true);
  end if;

  v_so_id := erp_norm_id(v_sh.so_id);
  v_cust := erp_norm_id(v_sh.customer_id);
  v_tx := coalesce(nullif(trim(v_sh.transaction_id), ''), 'TX-' || v_sid);

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
    begin
      insert into ar_amount_adjustment_log (
        adjust_id, ar_id, amount_before, amount_after, reason,
        adjusted_by, adjusted_at, source_type, source_id
      ) values (
        'ARA-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' ||
          upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)),
        v_ar_id, v_due, 0, '作廢出貨：' || v_reason, v_actor, v_ts,
        'SHIPMENT_VOID', v_sid
      );
    exception when unique_violation then
      null;
    end;
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
  'v4.3.12 Phase4 slice3：出貨 VOID；AR 歸零調整寫入 SHIPMENT_VOID 冪等鍵';

revoke all on function public.erp_ship_void_phase1_tx(text, text, text, timestamptz) from public;
grant execute on function public.erp_ship_void_phase1_tx(text, text, text, timestamptz) to service_role;
