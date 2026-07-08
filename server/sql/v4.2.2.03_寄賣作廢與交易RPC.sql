-- ERP v4.2.2 遷移步驟 3：寄賣作廢 + Postgres 單一交易 RPC（Supabase SQL Editor → Run）
-- 前置：v4.2.2.00 寄賣案件表、v4.2.1 應收表、inventory_movement / lot_balance 已存在
-- 用途：作廢結算／作廢收回在 DB 內原子完成（品項池 + 單據 + AR／庫存）

-- ── 小工具 ───────────────────────────────────────────────────
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

create or replace function public.erp_cc_refresh_case_status(
  p_case_id text,
  p_actor text,
  p_ts timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_all_done boolean := true;
  v_cnt int := 0;
  v_cur text;
  r record;
begin
  for r in
    select ship_qty, settled_qty, returned_qty
    from consignment_case_pool_item
    where upper(trim(case_id)) = upper(trim(p_case_id))
  loop
    v_cnt := v_cnt + 1;
    if greatest(
      0::numeric,
      coalesce(r.ship_qty, 0) - coalesce(r.settled_qty, 0) - coalesce(r.returned_qty, 0)
    ) > 0.000000001 then
      v_all_done := false;
    end if;
  end loop;

  select upper(trim(coalesce(status, ''))) into v_cur
  from consignment_case
  where upper(trim(case_id)) = upper(trim(p_case_id));

  if v_cnt > 0 and v_all_done and coalesce(v_cur, '') <> 'CLOSED' then
    update consignment_case
    set status = 'CLOSED',
        close_date = (p_ts at time zone 'UTC')::date,
        updated_by = p_actor,
        updated_at = p_ts
    where upper(trim(case_id)) = upper(trim(p_case_id));
  elsif v_cnt > 0 and not v_all_done and v_cur = 'CLOSED' then
    update consignment_case
    set status = 'OPEN',
        close_date = null,
        updated_by = p_actor,
        updated_at = p_ts
    where upper(trim(case_id)) = upper(trim(p_case_id));
  end if;
end;
$$;

-- ── 作廢結算（品項池 + 結算單 VOID + AR 結清）────────────────
create or replace function public.erp_cc_void_settlement_tx(
  p_settlement_id text,
  p_void_reason text,
  p_actor text,
  p_ts timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sid text := upper(trim(coalesce(p_settlement_id, '')));
  v_reason text := trim(coalesce(p_void_reason, ''));
  v_actor text := trim(coalesce(p_actor, ''));
  v_stl record;
  v_item record;
  v_pool record;
  v_ar record;
  v_ar_id text;
  v_received numeric;
  v_due numeric;
  v_n int;
  v_sys text;
begin
  if v_sid = '' then
    raise exception 'settlement_id required';
  end if;
  if v_reason = '' then
    raise exception 'void_reason required';
  end if;
  if v_actor = '' then
    raise exception 'updated_by required';
  end if;

  select * into v_stl
  from consignment_case_settlement
  where upper(trim(settlement_id)) = v_sid
  for update;

  if not found then
    raise exception 'Settlement not found: %', v_sid;
  end if;

  if upper(trim(coalesce(v_stl.status, ''))) = 'VOID' then
    return jsonb_build_object(
      'ok', true,
      'message', 'ALREADY_VOID',
      'idempotent', true,
      'settlement_id', v_sid,
      'case_id', upper(trim(v_stl.case_id)),
      'ar_id', upper(trim(coalesce(v_stl.ar_id, 'AR-STL-' || v_sid)))
    );
  end if;

  if upper(trim(coalesce(v_stl.status, ''))) <> 'POSTED' then
    raise exception 'Settlement cannot be voided: %', v_sid;
  end if;

  v_ar_id := upper(trim(coalesce(nullif(trim(v_stl.ar_id), ''), 'AR-STL-' || v_sid)));

  for v_item in
    select pool_item_id, settle_qty
    from consignment_case_settlement_item
    where upper(trim(settlement_id)) = v_sid
  loop
    if coalesce(v_item.settle_qty, 0) <= 0.000000001 then
      continue;
    end if;

    select * into v_pool
    from consignment_case_pool_item
    where upper(trim(pool_item_id)) = upper(trim(v_item.pool_item_id))
    for update;

    if not found then
      raise exception 'Pool item not found: %', v_item.pool_item_id;
    end if;

    if coalesce(v_pool.settled_qty, 0) + 0.000000001 < coalesce(v_item.settle_qty, 0) then
      raise exception 'Cannot revert more settled qty than recorded for %', v_item.pool_item_id;
    end if;

    update consignment_case_pool_item
    set settled_qty = coalesce(v_pool.settled_qty, 0) - coalesce(v_item.settle_qty, 0),
        updated_by = v_actor,
        updated_at = p_ts
    where upper(trim(pool_item_id)) = upper(trim(v_item.pool_item_id))
      and settled_qty = coalesce(v_pool.settled_qty, 0)
      and returned_qty = coalesce(v_pool.returned_qty, 0);

    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception 'ERR_CONSIGNMENT_POOL_CONFLICT: Pool item changed. Please refresh and retry.';
    end if;
  end loop;

  update consignment_case_settlement
  set status = 'VOID',
      system_remark = trim(
        coalesce(system_remark, '') ||
        case when coalesce(system_remark, '') <> '' then E'\n' else '' end ||
        '[作廢 ' || to_char(p_ts, 'YYYY-MM-DD"T"HH24:MI:SS') || '] ' || v_reason
      ),
      updated_by = v_actor,
      updated_at = p_ts
  where upper(trim(settlement_id)) = v_sid
    and upper(trim(coalesce(status, ''))) = 'POSTED';

  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'Settlement void update failed';
  end if;

  select * into v_ar from ar_receivable where upper(trim(ar_id)) = v_ar_id for update;
  if found then
    select coalesce(sum(amount), 0) into v_received
    from ar_payment
    where upper(trim(ar_id)) = v_ar_id;

    if coalesce(v_received, 0) > 0.000000001 then
      raise exception 'ERR_CONSIGNMENT_CASE_STL_HAS_PAYMENT: AR has payments, cannot void consignment settlement';
    end if;

    if upper(trim(coalesce(v_ar.status, ''))) = 'SETTLED'
       and upper(trim(coalesce(v_ar.close_mode, ''))) <> 'VOID' then
      raise exception 'ERR_CONSIGNMENT_CASE_STL_AR_CLOSED: AR already closed, cannot void consignment settlement';
    end if;

    v_due := round(coalesce(v_ar.amount_due, 0)::numeric, 2);
    if v_due > 0.000000001 then
      insert into ar_amount_adjustment_log (
        adjust_id, ar_id, amount_before, amount_after, reason, adjusted_by, adjusted_at
      ) values (
        'ARA-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' ||
          upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)),
        v_ar_id,
        v_due,
        0,
        '作廢寄賣結算：' || v_reason,
        v_actor,
        p_ts
      );
    end if;

    v_sys := trim(coalesce(v_ar.system_remark, ''));
    v_sys := trim(
      v_sys ||
      case when v_sys <> '' then E'\n' else '' end ||
      '[' || to_char(p_ts, 'YYYY-MM-DD"T"HH24:MI:SS') || '] ' || v_actor ||
      ' 作廢寄賣結算（應收 ' || v_due::text || ' → 0）：' || v_reason
    );

    update ar_receivable
    set amount_due = 0,
        amount_received = round(coalesce(v_received, 0)::numeric, 2),
        status = 'SETTLED',
        close_mode = 'VOID',
        close_reason = v_reason,
        closed_by = v_actor,
        closed_at = p_ts,
        system_remark = v_sys,
        updated_by = v_actor,
        updated_at = p_ts
    where upper(trim(ar_id)) = v_ar_id;
  end if;

  perform erp_cc_refresh_case_status(upper(trim(v_stl.case_id)), v_actor, p_ts);

  return jsonb_build_object(
    'ok', true,
    'message', 'VOIDED',
    'settlement_id', v_sid,
    'case_id', upper(trim(v_stl.case_id)),
    'ar_id', v_ar_id
  );
end;
$$;

-- ── 作廢收回（庫存沖銷 + 品項池 + 收回單 VOID）────────────────
create or replace function public.erp_cc_void_return_tx(
  p_return_id text,
  p_void_reason text,
  p_actor text,
  p_ts timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rid text := upper(trim(coalesce(p_return_id, '')));
  v_reason text := trim(coalesce(p_void_reason, ''));
  v_actor text := trim(coalesce(p_actor, ''));
  v_ret record;
  v_item record;
  v_pool record;
  v_in_mv record;
  v_mv_id text;
  v_qty numeric;
  v_avail numeric;
  v_n int;
  v_adj_remark text;
  v_pool_qty jsonb := '{}'::jsonb;
  v_pid text;
  v_delta numeric;
begin
  if v_rid = '' then
    raise exception 'return_id required';
  end if;
  if v_reason = '' then
    raise exception 'void_reason required';
  end if;
  if v_actor = '' then
    raise exception 'updated_by required';
  end if;

  if exists (
    select 1 from inventory_movement
    where upper(trim(ref_type)) = 'CONSIGNMENT_CASE_RETURN_CANCEL'
      and upper(trim(ref_id)) = v_rid
    limit 1
  ) then
    raise exception 'Return already has cancel reversal movements';
  end if;

  select * into v_ret
  from consignment_case_return
  where upper(trim(return_id)) = v_rid
  for update;

  if not found then
    raise exception 'Return not found: %', v_rid;
  end if;

  if upper(trim(coalesce(v_ret.status, ''))) = 'VOID' then
    return jsonb_build_object(
      'ok', true,
      'message', 'ALREADY_VOID',
      'idempotent', true,
      'return_id', v_rid,
      'case_id', upper(trim(v_ret.case_id))
    );
  end if;

  if upper(trim(coalesce(v_ret.status, ''))) <> 'POSTED' then
    raise exception 'Return cannot be voided: %', v_rid;
  end if;

  v_adj_remark := coalesce(nullif(v_reason, ''), '作廢沖銷');

  for v_item in
    select *
    from consignment_case_return_item
    where upper(trim(return_id)) = v_rid
  loop
    v_qty := abs(coalesce(v_item.return_qty, 0));
    if v_qty <= 0.000000001 then
      continue;
    end if;

    select * into v_in_mv
    from inventory_movement
    where upper(trim(lot_id)) = upper(trim(v_item.lot_id))
      and upper(trim(movement_type)) = 'IN'
      and upper(trim(ref_type)) = 'CONSIGNMENT_CASE_RETURN'
      and upper(trim(ref_id)) = v_rid
    order by created_at asc
    limit 1;

    if not found then
      raise exception 'IN movement not found for lot % (return %)', v_item.lot_id, v_rid;
    end if;

    v_avail := erp_lot_available_qty(v_item.lot_id);
    if v_avail + 0.000000001 < v_qty then
      raise exception 'Insufficient available qty for lot % (Cancel consignment return)', v_item.lot_id;
    end if;

    v_mv_id := erp_new_movement_id();
    insert into inventory_movement (
      movement_id, movement_type, lot_id, product_id, warehouse_id,
      transaction_id, parent_ref_type, parent_ref_id, qty, unit,
      ref_type, ref_id, issued_to, remark, created_by, created_at, system_remark
    ) values (
      v_mv_id,
      'ADJUST',
      v_item.lot_id,
      coalesce(v_in_mv.product_id, v_item.product_id),
      coalesce(v_in_mv.warehouse_id, v_ret.return_warehouse_id),
      coalesce(v_ret.transaction_id, v_in_mv.transaction_id),
      'CONSIGNMENT_CASE_RETURN',
      v_rid,
      -v_qty,
      coalesce(v_in_mv.unit, v_item.unit),
      'CONSIGNMENT_CASE_RETURN_CANCEL',
      v_rid,
      '',
      v_adj_remark,
      v_actor,
      p_ts,
      'REVERSAL(IN) of ' || coalesce(v_in_mv.movement_id, '')
    );

    update lot_balance
    set available_qty = coalesce(available_qty, 0) - v_qty,
        movement_count = coalesce(movement_count, 0) + 1,
        last_movement_id = v_mv_id,
        updated_at = p_ts,
        updated_by = v_actor
    where lot_id = v_item.lot_id;

    if not found then
      insert into lot_balance (lot_id, available_qty, movement_count, last_movement_id, updated_at, updated_by)
      select
        v_item.lot_id,
        coalesce((select sum(m.qty) from inventory_movement m where m.lot_id = v_item.lot_id), 0),
        coalesce((select count(*) from inventory_movement m where m.lot_id = v_item.lot_id), 0),
        v_mv_id,
        p_ts,
        v_actor;
    end if;

    if coalesce(trim(v_item.pool_item_id), '') <> '' then
      v_pid := upper(trim(v_item.pool_item_id));
      v_delta := coalesce((v_pool_qty ->> v_pid)::numeric, 0) + v_qty;
      v_pool_qty := jsonb_set(v_pool_qty, array[v_pid], to_jsonb(v_delta), true);
    end if;
  end loop;

  for v_pid, v_delta in
    select key, (value)::numeric
    from jsonb_each_text(v_pool_qty)
  loop
    select * into v_pool
    from consignment_case_pool_item
    where upper(trim(pool_item_id)) = v_pid
    for update;

    if not found then
      raise exception 'Pool item not found: %', v_pid;
    end if;

    if coalesce(v_pool.returned_qty, 0) + 0.000000001 < v_delta then
      raise exception 'Cannot revert more returned qty than recorded for %', v_pid;
    end if;

    update consignment_case_pool_item
    set returned_qty = coalesce(v_pool.returned_qty, 0) - v_delta,
        updated_by = v_actor,
        updated_at = p_ts
    where upper(trim(pool_item_id)) = v_pid
      and settled_qty = coalesce(v_pool.settled_qty, 0)
      and returned_qty = coalesce(v_pool.returned_qty, 0);

    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception 'ERR_CONSIGNMENT_POOL_CONFLICT: Pool item changed. Please refresh and retry.';
    end if;
  end loop;

  update consignment_case_return
  set status = 'VOID',
      system_remark = trim(
        coalesce(system_remark, '') ||
        case when coalesce(system_remark, '') <> '' then E'\n' else '' end ||
        '[作廢 ' || to_char(p_ts, 'YYYY-MM-DD"T"HH24:MI:SS') || '] ' || v_reason
      ),
      updated_by = v_actor,
      updated_at = p_ts
  where upper(trim(return_id)) = v_rid
    and upper(trim(coalesce(status, ''))) = 'POSTED';

  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'Return void update failed';
  end if;

  perform erp_cc_refresh_case_status(upper(trim(v_ret.case_id)), v_actor, p_ts);

  return jsonb_build_object(
    'ok', true,
    'message', 'VOIDED',
    'return_id', v_rid,
    'case_id', upper(trim(v_ret.case_id))
  );
end;
$$;

revoke all on function public.erp_new_movement_id() from public;
revoke all on function public.erp_lot_available_qty(text) from public;
revoke all on function public.erp_cc_refresh_case_status(text, text, timestamptz) from public;
revoke all on function public.erp_cc_void_settlement_tx(text, text, text, timestamptz) from public;
revoke all on function public.erp_cc_void_return_tx(text, text, text, timestamptz) from public;

grant execute on function public.erp_new_movement_id() to service_role;
grant execute on function public.erp_lot_available_qty(text) to service_role;
grant execute on function public.erp_cc_refresh_case_status(text, text, timestamptz) to service_role;
grant execute on function public.erp_cc_void_settlement_tx(text, text, text, timestamptz) to service_role;
grant execute on function public.erp_cc_void_return_tx(text, text, text, timestamptz) to service_role;

comment on function public.erp_cc_void_settlement_tx is 'v4.2.2 寄賣作廢結算（單一 Postgres transaction）';
comment on function public.erp_cc_void_return_tx is 'v4.2.2 寄賣作廢收回（單一 Postgres transaction）';
