-- ERP v4.2.2 遷移步驟 5：收回第二版 — 作廢已售退貨（Supabase SQL Editor → Run）
-- 前置：v4.2.2.03 寄賣作廢與交易 RPC 已執行
-- 用途：SOLD_RETURN 作廢時還原 settled_qty、結算明細、AR 折讓（非 SOLD_RETURN 行為不變）

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
  v_si record;
  v_adj record;
  v_ar record;
  v_mv_id text;
  v_qty numeric;
  v_avail numeric;
  v_n int;
  v_adj_remark text;
  v_pool_qty jsonb := '{}'::jsonb;
  v_pid text;
  v_delta numeric;
  v_is_sold boolean := false;
  v_case_id text;
  v_rest numeric;
  v_new_settle numeric;
  v_unit_price numeric;
  v_received numeric;
  v_due numeric;
  v_sys text;
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

  v_is_sold := upper(trim(coalesce(v_ret.return_reason, ''))) = 'SOLD_RETURN';
  v_case_id := upper(trim(v_ret.case_id));
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

    if v_is_sold then
      if coalesce(v_pool.settled_qty, 0) + v_delta + coalesce(v_pool.returned_qty, 0) - coalesce(v_pool.ship_qty, 0) > 0.000000001 then
        raise exception 'Revert sold return would exceed ship qty for %', v_pid;
      end if;

      update consignment_case_pool_item
      set settled_qty = coalesce(v_pool.settled_qty, 0) + v_delta,
          updated_by = v_actor,
          updated_at = p_ts
      where upper(trim(pool_item_id)) = v_pid
        and settled_qty = coalesce(v_pool.settled_qty, 0)
        and returned_qty = coalesce(v_pool.returned_qty, 0);

      get diagnostics v_n = row_count;
      if v_n <> 1 then
        raise exception 'ERR_CONSIGNMENT_POOL_CONFLICT: Pool item changed. Please refresh and retry.';
      end if;

      v_rest := v_delta;
      for v_si in
        select si.settlement_item_id, si.settle_qty, si.unit_price, s.settlement_date
        from consignment_case_settlement_item si
        join consignment_case_settlement s on upper(trim(s.settlement_id)) = upper(trim(si.settlement_id))
        where upper(trim(si.pool_item_id)) = v_pid
          and upper(trim(s.case_id)) = v_case_id
          and upper(trim(coalesce(s.status, ''))) = 'POSTED'
        order by s.settlement_date desc, si.settlement_item_id desc
      loop
        exit when v_rest <= 0.000000001;
        v_unit_price := coalesce(v_si.unit_price, 0);
        v_new_settle := coalesce(v_si.settle_qty, 0) + v_rest;
        update consignment_case_settlement_item
        set settle_qty = v_new_settle,
            amount = round(v_new_settle * v_unit_price, 2),
            updated_by = v_actor,
            updated_at = p_ts
        where upper(trim(settlement_item_id)) = upper(trim(v_si.settlement_item_id))
          and settle_qty = coalesce(v_si.settle_qty, 0);
        get diagnostics v_n = row_count;
        if v_n <> 1 then
          raise exception 'Settlement item changed. Please refresh and retry.';
        end if;
        v_rest := 0;
      end loop;

      if v_rest > 0.000000001 then
        raise exception 'Cannot restore settlement items for pool %', v_pid;
      end if;
    else
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
    end if;
  end loop;

  if v_is_sold then
    for v_adj in
      select *
      from ar_amount_adjustment_log
      where reason like '%寄賣已售退貨折讓%'
        and reason like '%' || v_rid || '%'
      order by adjusted_at asc
    loop
      select * into v_ar
      from ar_receivable
      where upper(trim(ar_id)) = upper(trim(v_adj.ar_id))
      for update;

      if not found then
        continue;
      end if;

      select coalesce(sum(amount), 0) into v_received
      from ar_payment
      where upper(trim(ar_id)) = upper(trim(v_adj.ar_id));

      v_due := round(coalesce(v_adj.amount_before, v_ar.amount_due, 0)::numeric, 2);

      v_sys := trim(coalesce(v_ar.system_remark, ''));
      v_sys := trim(
        v_sys ||
        case when v_sys <> '' then E'\n' else '' end ||
        '[' || to_char(p_ts, 'YYYY-MM-DD"T"HH24:MI:SS') || '] ' || v_actor ||
        ' 作廢已售退貨收回（應收還原 ' || coalesce(v_ar.amount_due, 0)::text || ' → ' || v_due::text || '）'
      );

      update ar_receivable
      set amount_due = v_due,
          amount_received = round(coalesce(v_received, 0)::numeric, 2),
          status = case
            when coalesce(v_received, 0) <= 0.000000001 then 'OPEN'
            when coalesce(v_received, 0) + 0.000000001 >= v_due then 'SETTLED'
            else 'PARTIAL'
          end,
          close_mode = case
            when coalesce(v_received, 0) + 0.000000001 >= v_due and v_due > 0.000000001 then 'NORMAL'
            else ''
          end,
          close_reason = '',
          closed_by = case
            when coalesce(v_received, 0) + 0.000000001 >= v_due and v_due > 0.000000001 then v_actor
            else ''
          end,
          closed_at = case
            when coalesce(v_received, 0) + 0.000000001 >= v_due and v_due > 0.000000001 then p_ts
            else null
          end,
          system_remark = v_sys,
          updated_by = v_actor,
          updated_at = p_ts
      where upper(trim(ar_id)) = upper(trim(v_adj.ar_id));

      delete from ar_amount_adjustment_log
      where upper(trim(adjust_id)) = upper(trim(v_adj.adjust_id));
    end loop;
  end if;

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

  perform erp_cc_refresh_case_status(v_case_id, v_actor, p_ts);

  return jsonb_build_object(
    'ok', true,
    'message', 'VOIDED',
    'return_id', v_rid,
    'case_id', v_case_id,
    'sold_return', v_is_sold
  );
end;
$$;

comment on function public.erp_cc_void_return_tx is 'v4.2.2 寄賣作廢收回（含 SOLD_RETURN 還原 settled_qty／AR 折讓）';
