-- ERP v4.2.5 遷移步驟 1：作廢寄賣結算時，若該客戶該月已有月結回饋則阻擋
-- 用法：Supabase SQL Editor → Run（DEV / PROD 各跑一次）

create or replace function public.erp_assert_no_dealer_rebate_lock_for_settlement(
  p_customer_id text,
  p_case_id text,
  p_settlement_date date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust text := upper(trim(coalesce(p_customer_id, '')));
  v_period text;
  v_rebate_id text;
begin
  if v_cust = '' and coalesce(trim(p_case_id), '') <> '' then
    select upper(trim(customer_id))
    into v_cust
    from consignment_case
    where upper(trim(case_id)) = upper(trim(p_case_id));
  end if;

  if p_settlement_date is null then
    raise exception '無法確認客戶或結算月份，為避免繞過月結回饋護欄，暫不允許作廢結算';
  end if;

  v_period := to_char(p_settlement_date, 'YYYY-MM');

  if v_cust = '' or v_period is null or v_period = '' then
    raise exception '無法確認客戶或結算月份，為避免繞過月結回饋護欄，暫不允許作廢結算';
  end if;

  select rebate_id
  into v_rebate_id
  from commercial_dealer_rebate
  where upper(trim(customer_id)) = v_cust
    and trim(period_ym) = v_period
    and upper(trim(coalesce(status, ''))) <> 'VOID'
  limit 1;

  if v_rebate_id is not null then
    raise exception '此客戶 % 已產生月結回饋（%）。請先到「Rebate 月結回饋」作廢該筆回饋後，再作廢寄賣結算。', v_period, v_rebate_id;
  end if;
end;
$$;

comment on function public.erp_assert_no_dealer_rebate_lock_for_settlement is 'v4.2.5 作廢結算前檢查月結回饋鎖定';

-- 於 erp_cc_void_settlement_tx 的 POSTED 檢查之後插入護欄（其餘邏輯與 v4.2.2.03 相同）
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

  perform public.erp_assert_no_dealer_rebate_lock_for_settlement(
    v_stl.customer_id,
    v_stl.case_id,
    v_stl.settlement_date
  );

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

revoke all on function public.erp_assert_no_dealer_rebate_lock_for_settlement(text, text, date) from public;
grant execute on function public.erp_assert_no_dealer_rebate_lock_for_settlement(text, text, date) to service_role;
