-- ERP v4.3.6：寄賣結算／收回 POST Phase2 單一 DB transaction【僅 DEV】
-- 前置：v4.2.2.00、v4.2.2.03（作廢 RPC）、v4.3.2 工具函式、v4.3.5（寄賣出貨）
-- 用途：結算過帳／未售收回過帳原子化（品項池 + 單據 + AR／庫存 + Dealer 折抵）
-- 計價／促銷／收回分配仍由 Node 權威計算後傳入（parity）

-- ── Dealer 折抵（結算；冪等鍵 SETTLEMENT_CREDIT + settlement_id）────────
create or replace function public.erp_apply_dealer_credit_at_settlement(
  p_ar_id text,
  p_settlement_id text,
  p_customer_id text,
  p_settlement_date date,
  p_actor text,
  p_ts timestamptz
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ar_id text := erp_norm_id(p_ar_id);
  v_sid text := erp_norm_id(p_settlement_id);
  v_cust text := erp_norm_id(p_customer_id);
  v_actor text := trim(coalesce(p_actor, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_reason text;
  v_src_type text := 'SETTLEMENT_CREDIT';
  v_stl_ym text;
  v_balance numeric := 0;
  v_due numeric := 0;
  v_received numeric := 0;
  v_total_posted numeric := 0;
  v_consumed numeric := 0;
  v_eligible_remaining numeric := 0;
  v_eligible numeric := 0;
  v_cut numeric := 0;
  v_new_due numeric := 0;
  r record;
  v_amt numeric;
  v_used numeric;
  v_remaining numeric;
begin
  if v_ar_id = '' then raise exception 'ERR_AR_ID_REQUIRED'; end if;
  if v_sid = '' then raise exception 'ERR_SETTLEMENT_ID_REQUIRED'; end if;
  if v_cust = '' then raise exception 'ERR_CUSTOMER_ID_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;
  if p_settlement_date is null then raise exception 'ERR_SETTLEMENT_DATE_REQUIRED'; end if;

  v_stl_ym := to_char(p_settlement_date, 'YYYY-MM');
  v_reason := '經銷回饋折抵（結算 ' || v_sid || '）';

  if exists (
    select 1 from ar_amount_adjustment_log
    where source_type = v_src_type and source_id = v_sid
  ) then
    return 0;
  end if;

  select coalesce(dealer_rebate_credit_balance, 0) into v_balance
  from customer where customer_id = v_cust for update;
  if not found then raise exception 'ERR_CUSTOMER_NOT_FOUND: %', v_cust; end if;

  v_balance := erp_round_money(v_balance);
  if v_balance <= 0.000000001 then return 0; end if;

  select coalesce(amount_due, 0), coalesce(amount_received, 0) into v_due, v_received
  from ar_receivable where ar_id = v_ar_id for update;
  if not found then raise exception 'ERR_AR_NOT_FOUND: %', v_ar_id; end if;

  v_due := erp_round_money(v_due);
  if v_due <= 0.000000001 then return 0; end if;

  v_received := erp_round_money(v_received);
  if v_due + 0.000000001 < v_received then
    raise exception 'ERR_AR_DUE_LT_RECEIVED: due=% received=%', v_due, v_received;
  end if;

  select coalesce(sum(rebate_amount), 0) into v_total_posted
  from commercial_dealer_rebate
  where customer_id = v_cust and status = 'POSTED' and settle_mode = 'CARRY_FORWARD';

  v_total_posted := erp_round_money(v_total_posted);
  v_consumed := erp_round_money(greatest(0, v_total_posted - v_balance));
  v_eligible_remaining := 0;

  for r in
    select period_ym, coalesce(rebate_amount, 0) as rebate_amount
    from commercial_dealer_rebate
    where customer_id = v_cust and status = 'POSTED' and settle_mode = 'CARRY_FORWARD'
    order by period_ym asc
  loop
    v_amt := erp_round_money(coalesce(r.rebate_amount, 0));
    v_used := erp_round_money(least(v_amt, v_consumed));
    v_consumed := erp_round_money(greatest(0, v_consumed - v_used));
    v_remaining := erp_round_money(v_amt - v_used);
    if trim(coalesce(r.period_ym, '')) < v_stl_ym then
      v_eligible_remaining := erp_round_money(v_eligible_remaining + v_remaining);
    end if;
  end loop;

  v_eligible := erp_round_money(least(v_balance, v_eligible_remaining));
  if v_eligible <= 0.000000001 then return 0; end if;

  v_cut := erp_round_money(least(v_eligible, v_due));
  if v_cut <= 0.000000001 then return 0; end if;

  v_new_due := erp_round_money(v_due - v_cut);
  if v_new_due + 0.000000001 < v_received then
    raise exception 'ERR_AR_DUE_LT_RECEIVED: due=% received=%', v_new_due, v_received;
  end if;

  begin
    insert into ar_amount_adjustment_log (
      adjust_id, ar_id, amount_before, amount_after, reason,
      adjusted_by, adjusted_at, source_type, source_id
    ) values (
      'ARA-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' ||
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)),
      v_ar_id, v_due, v_new_due, v_reason, v_actor, v_ts, v_src_type, v_sid
    );
  exception when unique_violation then
    return 0;
  end;

  update ar_receivable
  set amount_due = v_new_due,
      system_remark = trim(
        coalesce(system_remark, '') ||
        case when coalesce(system_remark, '') <> '' then E'\n' else '' end ||
        '[' || to_char(v_ts, 'YYYY-MM-DD"T"HH24:MI:SS') || '] ' || v_actor ||
        ' 經銷回饋折抵（應收 ' || v_due::text || ' → ' || v_new_due::text || '）：' || v_reason
      ),
      updated_by = v_actor,
      updated_at = v_ts
  where ar_id = v_ar_id;

  update customer
  set dealer_rebate_credit_balance = erp_round_money(v_balance - v_cut),
      updated_by = v_actor,
      updated_at = v_ts
  where customer_id = v_cust;

  return v_cut;
end;
$$;

comment on function public.erp_apply_dealer_credit_at_settlement is
  'v4.3.6：寄賣結算折抵；冪等鍵 SETTLEMENT_CREDIT+settlement_id';

revoke all on function public.erp_apply_dealer_credit_at_settlement(text, text, text, date, text, timestamptz) from public;
grant execute on function public.erp_apply_dealer_credit_at_settlement(text, text, text, date, text, timestamptz) to service_role;

-- ── 寄賣結算 POST（原子）────────────────────────────────────────
create or replace function public.erp_cc_post_settlement_phase2_tx(
  p_settlement_id text,
  p_case_id text,
  p_customer_id text,
  p_transaction_id text,
  p_settlement_date date,
  p_amount_system numeric,
  p_currency text,
  p_so_id text,
  p_shipment_id text,
  p_remark text,
  p_dealer_cumulative_tier_label text,
  p_dealer_cumulative_price_rate numeric,
  p_dealer_cumulative_price_source text,
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
  v_sid text := erp_norm_id(p_settlement_id);
  v_case_id text := erp_norm_id(p_case_id);
  v_cust text := erp_norm_id(p_customer_id);
  v_tx text := trim(coalesce(p_transaction_id, ''));
  v_so_id text := erp_norm_id(p_so_id);
  v_ship_id text := erp_norm_id(p_shipment_id);
  v_actor text := trim(coalesce(p_actor, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_existed record;
  v_case record;
  v_item jsonb;
  v_i int;
  v_pool_id text;
  v_qty numeric;
  v_pool record;
  v_unsold numeric;
  v_delta jsonb := '{}'::jsonb;
  v_ar_id text;
  v_amt numeric;
  v_credit numeric := 0;
  v_stl_item_id text;
  v_n int;
begin
  if v_sid = '' then raise exception 'ERR_SETTLEMENT_ID_REQUIRED'; end if;
  if v_case_id = '' then raise exception 'ERR_CASE_ID_REQUIRED'; end if;
  if v_cust = '' then raise exception 'ERR_CUSTOMER_ID_REQUIRED'; end if;
  if v_tx = '' then raise exception 'ERR_TRANSACTION_ID_REQUIRED'; end if;
  if p_settlement_date is null then raise exception 'ERR_SETTLEMENT_DATE_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;
  if p_items_json is null or jsonb_typeof(p_items_json) <> 'array' or jsonb_array_length(p_items_json) < 1 then
    raise exception 'ERR_ITEMS_REQUIRED';
  end if;

  select * into v_existed from consignment_case_settlement where settlement_id = v_sid;
  if found then
    if upper(trim(coalesce(v_existed.status, ''))) = 'POSTED' and erp_norm_id(v_existed.case_id) = v_case_id then
      return jsonb_build_object(
        'ok', true, 'message', 'SETTLED', 'idempotent', true,
        'settlement_id', v_sid, 'case_id', v_case_id,
        'ar_id', upper(trim(coalesce(v_existed.ar_id, 'AR-STL-' || v_sid))),
        'amount_system', coalesce(v_existed.amount_system, 0),
        'settlement_rpc', true, 'dealer_credit_in_tx', true
      );
    end if;
    raise exception 'Settlement already exists: %', v_sid;
  end if;

  select * into v_case from consignment_case where case_id = v_case_id for update;
  if not found then raise exception 'Consignment case not found: %', v_case_id; end if;
  if upper(trim(coalesce(v_case.status, ''))) = 'CLOSED' then
    raise exception 'Consignment case is CLOSED';
  end if;

  v_amt := erp_round_money(coalesce(p_amount_system, 0));

  for v_i in 0 .. jsonb_array_length(p_items_json) - 1 loop
    v_item := p_items_json -> v_i;
    v_pool_id := erp_norm_id(v_item ->> 'pool_item_id');
    v_qty := coalesce((v_item ->> 'settle_qty')::numeric, 0);
    if v_pool_id = '' then raise exception 'pool_item_id required (items[%])', v_i; end if;
    if v_qty <= 0.000000001 then raise exception 'settle_qty must be > 0 (items[%])', v_i; end if;
    v_delta := jsonb_set(
      v_delta,
      array[v_pool_id],
      to_jsonb(coalesce((v_delta ->> v_pool_id)::numeric, 0) + v_qty),
      true
    );
  end loop;

  for v_pool_id, v_qty in select key, (value)::numeric from jsonb_each_text(v_delta) loop
    select * into v_pool from consignment_case_pool_item where pool_item_id = v_pool_id for update;
    if not found then raise exception 'Pool item not found: %', v_pool_id; end if;
    v_unsold := greatest(
      0::numeric,
      coalesce(v_pool.ship_qty, 0) - coalesce(v_pool.settled_qty, 0) - coalesce(v_pool.returned_qty, 0)
    );
    if v_qty - 1e-9 > v_unsold then
      raise exception 'settle_qty exceeds unsold remaining for % (remaining %)', v_pool_id, v_unsold;
    end if;
  end loop;

  begin
    insert into consignment_case_settlement (
      settlement_id, case_id, customer_id, transaction_id, settlement_date,
      amount_system, ar_id, status, remark,
      dealer_cumulative_tier_label, dealer_cumulative_price_rate, dealer_cumulative_price_source,
      created_by, created_at, updated_by, updated_at
    ) values (
      v_sid, v_case_id, v_cust, v_tx, p_settlement_date,
      v_amt, '', 'POSTED', coalesce(p_remark, ''),
      coalesce(p_dealer_cumulative_tier_label, ''),
      p_dealer_cumulative_price_rate,
      coalesce(p_dealer_cumulative_price_source, ''),
      v_actor, v_ts, '', null
    );
  exception when undefined_column then
    insert into consignment_case_settlement (
      settlement_id, case_id, customer_id, transaction_id, settlement_date,
      amount_system, ar_id, status, remark,
      created_by, created_at, updated_by, updated_at
    ) values (
      v_sid, v_case_id, v_cust, v_tx, p_settlement_date,
      v_amt, '', 'POSTED', coalesce(p_remark, ''),
      v_actor, v_ts, '', null
    );
  end;

  for v_i in 0 .. jsonb_array_length(p_items_json) - 1 loop
    v_item := p_items_json -> v_i;
    v_stl_item_id := coalesce(nullif(trim(v_item ->> 'settlement_item_id'), ''), v_sid || '-IT-' || lpad((v_i + 1)::text, 3, '0'));
    insert into consignment_case_settlement_item (
      settlement_item_id, settlement_id, pool_item_id,
      shipment_item_id, so_item_id, product_id,
      settle_qty, billable_qty, free_qty, unit,
      list_unit_price, settle_unit_price, unit_price, amount,
      promo_scheme_id, promo_type, promo_scheme_name,
      promo_discount_pct, promo_buy_qty, promo_scheme_free_qty,
      remark, created_by, created_at, updated_by, updated_at
    ) values (
      v_stl_item_id, v_sid, erp_norm_id(v_item ->> 'pool_item_id'),
      erp_norm_id(v_item ->> 'shipment_item_id'), erp_norm_id(v_item ->> 'so_item_id'), erp_norm_id(v_item ->> 'product_id'),
      coalesce((v_item ->> 'settle_qty')::numeric, 0),
      coalesce((v_item ->> 'billable_qty')::numeric, (v_item ->> 'settle_qty')::numeric, 0),
      coalesce((v_item ->> 'free_qty')::numeric, 0),
      coalesce(v_item ->> 'unit', ''),
      coalesce((v_item ->> 'list_unit_price')::numeric, (v_item ->> 'unit_price')::numeric, 0),
      coalesce((v_item ->> 'settle_unit_price')::numeric, (v_item ->> 'unit_price')::numeric, 0),
      coalesce((v_item ->> 'unit_price')::numeric, (v_item ->> 'settle_unit_price')::numeric, 0),
      erp_round_money(coalesce((v_item ->> 'amount')::numeric, 0)),
      coalesce(v_item ->> 'promo_scheme_id', ''),
      coalesce(v_item ->> 'promo_type', ''),
      coalesce(v_item ->> 'promo_scheme_name', ''),
      nullif(v_item ->> 'promo_discount_pct', '')::numeric,
      nullif(v_item ->> 'promo_buy_qty', '')::numeric,
      nullif(v_item ->> 'promo_scheme_free_qty', '')::numeric,
      coalesce(v_item ->> 'remark', ''),
      v_actor, v_ts, '', null
    );
  end loop;

  for v_pool_id, v_qty in select key, (value)::numeric from jsonb_each_text(v_delta) loop
    select * into v_pool from consignment_case_pool_item where pool_item_id = v_pool_id for update;
    update consignment_case_pool_item
    set settled_qty = coalesce(v_pool.settled_qty, 0) + v_qty,
        updated_by = v_actor, updated_at = v_ts
    where pool_item_id = v_pool_id
      and settled_qty = coalesce(v_pool.settled_qty, 0)
      and returned_qty = coalesce(v_pool.returned_qty, 0);
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception 'ERR_CONSIGNMENT_POOL_CONFLICT: Pool item changed. Please refresh and retry.';
    end if;
  end loop;

  v_ar_id := 'AR-STL-' || v_sid;
  if not exists (select 1 from ar_receivable where ar_id = v_ar_id) then
    insert into ar_receivable (
      ar_id, source_type, source_id, customer_id, so_id, shipment_id, settlement_id,
      transaction_id, ar_date, currency, amount_system, amount_due, amount_received,
      status, close_mode, close_reason, closed_by, closed_at, remark,
      created_by, created_at, updated_by, updated_at, system_remark
    ) values (
      v_ar_id, 'CONSIGNMENT_CASE_SETTLEMENT', v_sid, v_cust, v_so_id, v_ship_id, v_sid,
      v_tx, p_settlement_date, upper(trim(coalesce(p_currency, 'USD'))), v_amt, v_amt, 0,
      'OPEN', '', '', '', null, '',
      v_actor, v_ts, '', null, 'Case: ' || v_case_id
    );
  end if;

  update consignment_case_settlement
  set ar_id = v_ar_id, updated_by = v_actor, updated_at = v_ts
  where settlement_id = v_sid;

  v_credit := coalesce(
    erp_apply_dealer_credit_at_settlement(v_ar_id, v_sid, v_cust, p_settlement_date, v_actor, v_ts),
    0
  );

  perform erp_cc_refresh_case_status(v_case_id, v_actor, v_ts);

  return jsonb_build_object(
    'ok', true, 'message', 'SETTLED',
    'settlement_id', v_sid, 'case_id', v_case_id,
    'ar_id', v_ar_id, 'amount_system', v_amt,
    'dealer_credit_applied', v_credit,
    'dealer_credit_in_tx', true,
    'settlement_rpc', true
  );
end;
$$;

comment on function public.erp_cc_post_settlement_phase2_tx is
  'v4.3.6：寄賣結算 POST 單一 transaction（池子+結算+AR+折抵）';

-- ── 寄賣收回 POST（原子）────────────────────────────────────────
create or replace function public.erp_cc_post_return_phase2_tx(
  p_return_id text,
  p_case_id text,
  p_customer_id text,
  p_transaction_id text,
  p_return_reason text,
  p_return_date date,
  p_return_warehouse_id text,
  p_filter_unit_price numeric,
  p_remark text,
  p_lines_json jsonb,
  p_actor text default '',
  p_ts timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rid text := erp_norm_id(p_return_id);
  v_case_id text := erp_norm_id(p_case_id);
  v_cust text := erp_norm_id(p_customer_id);
  v_tx text := trim(coalesce(p_transaction_id, ''));
  v_reason text := upper(trim(coalesce(p_return_reason, '')));
  v_ret_wh text := erp_norm_id(p_return_warehouse_id);
  v_actor text := trim(coalesce(p_actor, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_existed record;
  v_case record;
  v_line jsonb;
  v_i int;
  v_pool_id text;
  v_qty numeric;
  v_pool record;
  v_unsold numeric;
  v_delta jsonb := '{}'::jsonb;
  v_src_lot_id text;
  v_target_lot_id text;
  v_lot record;
  v_mv_id text;
  v_ret_item_id text;
  v_n int;
  v_line_count int := 0;
  v_new_lot_id text;
begin
  if v_rid = '' then raise exception 'ERR_RETURN_ID_REQUIRED'; end if;
  if v_case_id = '' then raise exception 'ERR_CASE_ID_REQUIRED'; end if;
  if v_cust = '' then raise exception 'ERR_CUSTOMER_ID_REQUIRED'; end if;
  if v_tx = '' then raise exception 'ERR_TRANSACTION_ID_REQUIRED'; end if;
  if v_reason = '' then raise exception 'ERR_RETURN_REASON_REQUIRED'; end if;
  if p_return_date is null then raise exception 'ERR_RETURN_DATE_REQUIRED'; end if;
  if v_ret_wh = '' then raise exception 'ERR_RETURN_WAREHOUSE_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;
  if p_lines_json is null or jsonb_typeof(p_lines_json) <> 'array' or jsonb_array_length(p_lines_json) < 1 then
    raise exception 'ERR_LINES_REQUIRED';
  end if;

  select * into v_existed from consignment_case_return where return_id = v_rid;
  if found then
    if upper(trim(coalesce(v_existed.status, ''))) = 'POSTED' and erp_norm_id(v_existed.case_id) = v_case_id then
      return jsonb_build_object(
        'ok', true, 'message', 'RETURNED', 'idempotent', true,
        'return_id', v_rid, 'case_id', v_case_id, 'return_rpc', true
      );
    end if;
    raise exception 'Return already exists: %', v_rid;
  end if;

  select * into v_case from consignment_case where case_id = v_case_id for update;
  if not found then raise exception 'Consignment case not found: %', v_case_id; end if;
  if upper(trim(coalesce(v_case.status, ''))) = 'CLOSED' then
    raise exception 'Consignment case is CLOSED';
  end if;

  for v_i in 0 .. jsonb_array_length(p_lines_json) - 1 loop
    v_line := p_lines_json -> v_i;
    v_pool_id := erp_norm_id(v_line ->> 'pool_item_id');
    v_qty := coalesce((v_line ->> 'qty')::numeric, 0);
    if v_pool_id = '' then raise exception 'pool_item_id required (lines[%])', v_i; end if;
    if v_qty <= 0.000000001 then raise exception 'qty must be > 0 (lines[%])', v_i; end if;
    v_delta := jsonb_set(
      v_delta,
      array[v_pool_id],
      to_jsonb(coalesce((v_delta ->> v_pool_id)::numeric, 0) + v_qty),
      true
    );
  end loop;

  for v_pool_id, v_qty in select key, (value)::numeric from jsonb_each_text(v_delta) loop
    select * into v_pool from consignment_case_pool_item where pool_item_id = v_pool_id for update;
    if not found then raise exception 'Pool item not found: %', v_pool_id; end if;
    v_unsold := greatest(
      0::numeric,
      coalesce(v_pool.ship_qty, 0) - coalesce(v_pool.settled_qty, 0) - coalesce(v_pool.returned_qty, 0)
    );
    if v_qty - 1e-9 > v_unsold then
      raise exception 'return_qty exceeds unsold remaining for % (remaining %)', v_pool_id, v_unsold;
    end if;
  end loop;

  insert into consignment_case_return (
    return_id, case_id, customer_id, transaction_id,
    return_reason, return_date, return_warehouse_id, filter_unit_price,
    status, remark, created_by, created_at, updated_by, updated_at
  ) values (
    v_rid, v_case_id, v_cust, v_tx,
    v_reason, p_return_date, v_ret_wh, p_filter_unit_price,
    'POSTED', coalesce(p_remark, ''),
    v_actor, v_ts, '', null
  );

  for v_i in 0 .. jsonb_array_length(p_lines_json) - 1 loop
    v_line := p_lines_json -> v_i;
    v_line_count := v_line_count + 1;
    v_ret_item_id := coalesce(nullif(trim(v_line ->> 'return_item_id'), ''), v_rid || '-IT-' || lpad(v_line_count::text, 3, '0'));
    v_pool_id := erp_norm_id(v_line ->> 'pool_item_id');
    v_qty := coalesce((v_line ->> 'qty')::numeric, 0);
    v_src_lot_id := erp_norm_id(v_line ->> 'source_lot_id');
    if v_src_lot_id = '' then v_src_lot_id := erp_norm_id(v_line ->> 'lot_id'); end if;
    if v_src_lot_id = '' then raise exception 'source_lot_id required (lines[%])', v_i; end if;

    select * into v_lot from lot where lot_id = v_src_lot_id;
    if not found then raise exception 'Lot not found: %', v_src_lot_id; end if;

    v_target_lot_id := v_src_lot_id;
    if erp_norm_id(v_lot.warehouse_id) <> v_ret_wh then
      v_new_lot_id := 'LOT-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' ||
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4));
      insert into lot (
        lot_id, product_id, warehouse_id, source_type, source_id,
        qty, unit, type, status, inventory_status,
        received_date, manufacture_date, expiry_date, factory_lot,
        remark, created_by, created_at, system_remark
      ) values (
        v_new_lot_id, v_lot.product_id, v_ret_wh, 'CONSIGNMENT_CASE_RETURN', v_rid,
        v_qty, v_lot.unit, coalesce(v_lot.type, 'NORMAL'), coalesce(v_lot.status, 'APPROVED'), 'ACTIVE',
        (v_ts at time zone 'UTC')::date, v_lot.manufacture_date, v_lot.expiry_date, v_lot.factory_lot,
        '', v_actor, v_ts,
        'Consignment return ' || v_rid || ' from ' || v_src_lot_id || ' (' ||
          coalesce(v_lot.warehouse_id, '') || ' -> ' || v_ret_wh || ', case ' || v_case_id || ')'
      );
      v_target_lot_id := v_new_lot_id;
    end if;

    insert into consignment_case_return_item (
      return_item_id, return_id, factory_lot, product_id, return_qty,
      pool_item_id, shipment_item_id, so_item_id, lot_id,
      recognized_unit_price, unit, remark,
      created_by, created_at, updated_by, updated_at
    ) values (
      v_ret_item_id, v_rid,
      coalesce(v_line ->> 'factory_lot', v_lot.factory_lot, ''),
      erp_norm_id(coalesce(v_line ->> 'product_id', v_lot.product_id)),
      v_qty,
      v_pool_id,
      erp_norm_id(v_line ->> 'shipment_item_id'),
      erp_norm_id(v_line ->> 'so_item_id'),
      v_target_lot_id,
      coalesce((v_line ->> 'unit_price')::numeric, 0),
      coalesce(v_line ->> 'unit', v_lot.unit, ''),
      coalesce(v_line ->> 'remark', ''),
      v_actor, v_ts, '', null
    );

    v_mv_id := erp_new_movement_id();
    insert into inventory_movement (
      movement_id, movement_type, lot_id, product_id, warehouse_id,
      transaction_id, parent_ref_type, parent_ref_id, qty, unit,
      ref_type, ref_id, issued_to, remark, created_by, created_at, system_remark
    ) values (
      v_mv_id, 'IN', v_target_lot_id,
      erp_norm_id(coalesce(v_line ->> 'product_id', v_lot.product_id)),
      v_ret_wh, v_tx, 'CONSIGNMENT_CASE_RETURN', v_rid,
      abs(v_qty), coalesce(v_line ->> 'unit', v_lot.unit, ''),
      'CONSIGNMENT_CASE_RETURN', v_rid, '',
      coalesce(p_remark, ''),
      v_actor, v_ts,
      'Consignment case return IN: ' || v_rid || ' (' || v_case_id || ')' ||
        case when v_target_lot_id <> v_src_lot_id then ' new lot from ' || v_src_lot_id else '' end
    );

    update lot_balance
    set available_qty = coalesce(available_qty, 0) + abs(v_qty),
        movement_count = coalesce(movement_count, 0) + 1,
        last_movement_id = v_mv_id,
        updated_at = v_ts, updated_by = v_actor
    where lot_id = v_target_lot_id;

    if not found then
      insert into lot_balance (lot_id, available_qty, movement_count, last_movement_id, updated_at, updated_by)
      values (
        v_target_lot_id,
        coalesce((select sum(m.qty) from inventory_movement m where m.lot_id = v_target_lot_id), 0),
        coalesce((select count(*)::int from inventory_movement m where m.lot_id = v_target_lot_id), 0),
        v_mv_id, v_ts, v_actor
      );
    end if;
  end loop;

  for v_pool_id, v_qty in select key, (value)::numeric from jsonb_each_text(v_delta) loop
    select * into v_pool from consignment_case_pool_item where pool_item_id = v_pool_id for update;
    update consignment_case_pool_item
    set returned_qty = coalesce(v_pool.returned_qty, 0) + v_qty,
        updated_by = v_actor, updated_at = v_ts
    where pool_item_id = v_pool_id
      and settled_qty = coalesce(v_pool.settled_qty, 0)
      and returned_qty = coalesce(v_pool.returned_qty, 0);
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception 'ERR_CONSIGNMENT_POOL_CONFLICT: Pool item changed. Please refresh and retry.';
    end if;
  end loop;

  perform erp_cc_refresh_case_status(v_case_id, v_actor, v_ts);

  return jsonb_build_object(
    'ok', true, 'message', 'RETURNED',
    'return_id', v_rid, 'case_id', v_case_id,
    'item_count', v_line_count,
    'return_rpc', true
  );
end;
$$;

comment on function public.erp_cc_post_return_phase2_tx is
  'v4.3.6：寄賣收回 POST 單一 transaction（池子+收回+庫存 IN）';

revoke all on function public.erp_cc_post_settlement_phase2_tx(
  text, text, text, text, date, numeric, text, text, text, text, text, numeric, text, jsonb, text, timestamptz
) from public;
grant execute on function public.erp_cc_post_settlement_phase2_tx(
  text, text, text, text, date, numeric, text, text, text, text, text, numeric, text, jsonb, text, timestamptz
) to service_role;

revoke all on function public.erp_cc_post_return_phase2_tx(
  text, text, text, text, text, date, text, numeric, text, jsonb, text, timestamptz
) from public;
grant execute on function public.erp_cc_post_return_phase2_tx(
  text, text, text, text, text, date, text, numeric, text, jsonb, text, timestamptz
) to service_role;
