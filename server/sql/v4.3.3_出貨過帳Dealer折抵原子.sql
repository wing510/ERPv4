-- ERP v4.3.3：一般出貨 POST 併入 Dealer 折抵（同 DB transaction）【僅 DEV 先跑】
-- 前置：v4.3.1_銷售與出貨計價快照.sql、v4.3.2_出貨過帳交易Phase1.sql
-- 用法：Supabase SQL Editor（DEV 專案）→ 全選貼上 → Run
-- 正式庫：暫不執行

-- ── AR 調整冪等鍵 ───────────────────────────────────────────────
alter table ar_amount_adjustment_log
  add column if not exists source_type text,
  add column if not exists source_id text;

comment on column ar_amount_adjustment_log.source_type is
  '調整來源類型；出貨折抵＝SHIPMENT_CREDIT（財務冪等鍵）';
comment on column ar_amount_adjustment_log.source_id is
  '調整來源鍵；出貨折抵＝shipment_id';

create unique index if not exists idx_ar_adj_source_unique
  on ar_amount_adjustment_log (source_type, source_id)
  where source_type is not null and source_id is not null;

-- ── 工具 ─────────────────────────────────────────────────────────
create or replace function public.erp_round_money(p_amount numeric)
returns numeric
language sql
immutable
as $$
  select round(coalesce(p_amount, 0)::numeric, 2);
$$;

-- ── Dealer Credit（同交易；冪等鍵 SHIPMENT_CREDIT + shipment_id）──
create or replace function public.erp_apply_dealer_credit_at_shipment(
  p_ar_id text,
  p_shipment_id text,
  p_customer_id text,
  p_ship_date date,
  p_actor text,
  p_ts timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ar_id text := erp_norm_id(p_ar_id);
  v_sid text := erp_norm_id(p_shipment_id);
  v_cust text := erp_norm_id(p_customer_id);
  v_actor text := trim(coalesce(p_actor, ''));
  v_ts timestamptz := coalesce(p_ts, now());
  v_reason text;
  v_src_type text := 'SHIPMENT_CREDIT';
  v_ship_ym text;
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
  if v_sid = '' then raise exception 'ERR_SHIPMENT_ID_REQUIRED'; end if;
  if v_cust = '' then raise exception 'ERR_CUSTOMER_ID_REQUIRED'; end if;
  if v_actor = '' then raise exception 'ERR_ACTOR_REQUIRED'; end if;
  if p_ship_date is null then raise exception 'ERR_SHIP_DATE_REQUIRED'; end if;

  v_ship_ym := to_char(p_ship_date, 'YYYY-MM');
  v_reason := '經銷回饋折抵（出貨 ' || v_sid || '）';

  if exists (
    select 1 from ar_amount_adjustment_log
    where source_type = v_src_type and source_id = v_sid
  ) then
    return;
  end if;

  select coalesce(dealer_rebate_credit_balance, 0) into v_balance
  from customer where customer_id = v_cust for update;
  if not found then raise exception 'ERR_CUSTOMER_NOT_FOUND: %', v_cust; end if;

  v_balance := erp_round_money(v_balance);
  if v_balance <= 0.000000001 then return; end if;

  select coalesce(amount_due, 0), coalesce(amount_received, 0) into v_due, v_received
  from ar_receivable where ar_id = v_ar_id for update;
  if not found then raise exception 'ERR_AR_NOT_FOUND: %', v_ar_id; end if;

  v_due := erp_round_money(v_due);
  if v_due <= 0.000000001 then return; end if;

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
    if trim(coalesce(r.period_ym, '')) < v_ship_ym then
      v_eligible_remaining := erp_round_money(v_eligible_remaining + v_remaining);
    end if;
  end loop;

  v_eligible := erp_round_money(least(v_balance, v_eligible_remaining));
  if v_eligible <= 0.000000001 then return; end if;

  v_cut := erp_round_money(least(v_eligible, v_due));
  if v_cut <= 0.000000001 then return; end if;

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
    return;
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
end;
$$;

comment on function public.erp_apply_dealer_credit_at_shipment is
  'v4.3.3：出貨折抵；冪等鍵 SHIPMENT_CREDIT+shipment_id；與 Node computeEligibleDealerCreditForSettlement_ 同口徑';

revoke all on function public.erp_apply_dealer_credit_at_shipment(text, text, text, date, text, timestamptz) from public;
grant execute on function public.erp_apply_dealer_credit_at_shipment(text, text, text, date, text, timestamptz) to service_role;

-- ── 升級 erp_ship_post_phase1_tx：AR 後同交易套用 Dealer 折抵 ───
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
  v_final_due numeric := 0;
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
      v_ar_id := 'AR-' || v_sid;
      perform erp_apply_dealer_credit_at_shipment(
        v_ar_id, v_sid, v_cust, v_existed.ship_date, v_actor, coalesce(p_ts, now())
      );
      select coalesce(amount_due, 0), coalesce(amount_system, 0)
      into v_final_due, v_amount
      from ar_receivable where ar_id = v_ar_id;
      return jsonb_build_object(
        'ok', true, 'message', 'POSTED', 'idempotent', true,
        'shipment_id', v_sid, 'ar_id', v_ar_id,
        'amount_system', erp_round_money(v_amount),
        'amount_due', erp_round_money(v_final_due),
        'dealer_credit_in_tx', true
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

  perform erp_apply_dealer_credit_at_shipment(v_ar_id, v_sid, v_cust, p_ship_date, v_actor, p_ts);

  select coalesce(amount_due, 0) into v_final_due from ar_receivable where ar_id = v_ar_id;

  return jsonb_build_object(
    'ok', true, 'message', 'POSTED',
    'shipment_id', v_sid, 'so_id', v_so_id,
    'ar_id', v_ar_id,
    'amount_system', v_amount,
    'amount_due', erp_round_money(v_final_due),
    'dealer_credit_in_tx', true
  );
end;
$$;

comment on function public.erp_ship_post_phase1_tx is
  'v4.3.3 Phase1：NORMAL 出貨 POST + Dealer 折抵 單一 transaction';

revoke all on function public.erp_ship_post_phase1_tx(
  text, text, text, date, text, text, text, text, text, text, text, text, text, text,
  jsonb, jsonb, numeric, text, text, text, timestamptz
) from public;
grant execute on function public.erp_ship_post_phase1_tx(
  text, text, text, date, text, text, text, text, text, text, text, text, text, text,
  jsonb, jsonb, numeric, text, text, text, timestamptz
) to service_role;
